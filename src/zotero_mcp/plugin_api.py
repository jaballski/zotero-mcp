"""
HTTP API server for the Zotero Research Assistant plugin.

This module provides a lightweight HTTP API that the Zotero plugin
communicates with to perform semantic search, AI chat, and index
management operations. It bridges the plugin's JavaScript frontend
to the existing zotero-mcp Python backend (semantic search, embeddings,
LLM orchestration).
"""

import json
import logging
import os
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import urlparse, parse_qs

from .semantic_search import create_semantic_search, ZoteroSemanticSearch
from .client import get_zotero_client, format_item_metadata
from .utils import format_creators

logger = logging.getLogger(__name__)


class PluginAPIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Zotero Research Assistant plugin API."""

    # Reference to the shared state set by the server
    semantic_search: ZoteroSemanticSearch | None = None
    config_path: str | None = None

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        """Handle GET requests."""
        path = urlparse(self.path).path

        if path == "/api/status":
            self._handle_status()
        elif path == "/api/health":
            self._handle_health()
        else:
            self._send_error(404, f"Not found: {path}")

    def do_POST(self):
        """Handle POST requests."""
        path = urlparse(self.path).path

        try:
            body = self._read_body()
        except Exception as e:
            self._send_error(400, f"Invalid request body: {e}")
            return

        if path == "/api/search":
            self._handle_search(body)
        elif path == "/api/chat":
            self._handle_chat(body)
        elif path == "/api/index/update":
            self._handle_index_update(body)
        elif path == "/api/similar":
            self._handle_find_similar(body)
        elif path == "/api/summarize":
            self._handle_summarize(body)
        else:
            self._send_error(404, f"Not found: {path}")

    # ─── Endpoint Handlers ────────────────────────────────────

    def _handle_health(self):
        """Health check endpoint."""
        self._send_json({"status": "ok", "version": "0.1.0"})

    def _handle_status(self):
        """Get backend and index status."""
        try:
            search = self._get_search()
            status = search.get_database_status()
            status["backend"] = "running"
            self._send_json(status)
        except Exception as e:
            self._send_json({
                "backend": "running",
                "index": "error",
                "error": str(e),
            })

    def _handle_search(self, body: dict):
        """
        Perform semantic/hybrid/keyword search.

        Request body:
            query: str - Search query
            mode: str - "semantic", "keyword", or "hybrid" (default: "hybrid")
            limit: int - Max results (default: 20)
            filters: dict - Optional metadata filters
        """
        query = body.get("query", "").strip()
        if not query:
            self._send_error(400, "Query cannot be empty")
            return

        mode = body.get("mode", "hybrid")
        limit = body.get("limit", 20)
        filters = body.get("filters")

        try:
            results = []

            if mode in ("semantic", "hybrid"):
                search = self._get_search()
                semantic_results = search.search(
                    query=query, limit=limit, filters=filters
                )

                for r in semantic_results.get("results", []):
                    zotero_item = r.get("zotero_item", {})
                    data = zotero_item.get("data", {}) if zotero_item else {}
                    metadata = r.get("metadata", {})

                    results.append({
                        "item_key": r.get("item_key", ""),
                        "title": data.get("title", metadata.get("title", "Untitled")),
                        "creators": format_creators(data.get("creators", [])) if data.get("creators") else metadata.get("creators", ""),
                        "date": data.get("date", metadata.get("date", "")),
                        "score": r.get("similarity_score", 0),
                        "passage": (r.get("matched_text", "") or "")[:300],
                        "item_type": data.get("itemType", metadata.get("item_type", "")),
                        "abstract": data.get("abstractNote", "")[:200],
                    })

            if mode == "keyword":
                # Use Zotero's built-in search
                zot = get_zotero_client()
                items = zot.items(q=query, limit=limit, qmode="everything")
                for item in items:
                    data = item.get("data", {})
                    if data.get("itemType") in ("attachment", "note"):
                        continue
                    results.append({
                        "item_key": item.get("key", ""),
                        "title": data.get("title", "Untitled"),
                        "creators": format_creators(data.get("creators", [])),
                        "date": data.get("date", ""),
                        "score": 1.0,  # Keyword matches are binary
                        "passage": "",
                        "item_type": data.get("itemType", ""),
                        "abstract": data.get("abstractNote", "")[:200],
                    })

            if mode == "hybrid" and not filters:
                # Deduplicate: semantic results take priority
                seen_keys = {r["item_key"] for r in results}
                try:
                    zot = get_zotero_client()
                    keyword_items = zot.items(
                        q=query, limit=limit // 2, qmode="everything"
                    )
                    for item in keyword_items:
                        data = item.get("data", {})
                        key = item.get("key", "")
                        if (
                            key not in seen_keys
                            and data.get("itemType") not in ("attachment", "note")
                        ):
                            results.append({
                                "item_key": key,
                                "title": data.get("title", "Untitled"),
                                "creators": format_creators(data.get("creators", [])),
                                "date": data.get("date", ""),
                                "score": 0.5,  # Lower score for keyword-only matches
                                "passage": "",
                                "item_type": data.get("itemType", ""),
                                "abstract": data.get("abstractNote", "")[:200],
                            })
                except Exception as e:
                    logger.warning(f"Keyword search fallback failed: {e}")

            # Sort by score descending
            results.sort(key=lambda x: x.get("score", 0), reverse=True)

            self._send_json({"results": results[:limit], "total": len(results)})

        except Exception as e:
            logger.error(f"Search error: {e}\n{traceback.format_exc()}")
            self._send_error(500, f"Search failed: {e}")

    def _handle_chat(self, body: dict):
        """
        AI chat with source-grounded answers.

        Request body:
            query: str - User's question
            context: dict - Context specification:
                type: "items" | "collection" | "library"
                item_keys: list[str] (for type="items")
                collection_key: str (for type="collection")
            provider: str - LLM provider (anthropic/openai/google/ollama)
            model: str - Model name
            api_key: str - API key (if not in env)
        """
        query = body.get("query", "").strip()
        if not query:
            self._send_error(400, "Query cannot be empty")
            return

        context = body.get("context", {"type": "library"})
        provider = body.get("provider", "")
        model = body.get("model", "")
        api_key = body.get("api_key", "")

        try:
            # Step 1: Gather relevant text from context
            context_texts = self._gather_context(context, query)

            # Step 2: Build the prompt with source grounding
            sources_text = "\n\n---\n\n".join(
                [
                    f"Source [{i+1}]: {s['title']}\n{s['text']}"
                    for i, s in enumerate(context_texts)
                ]
            )

            system_prompt = (
                "You are a research assistant helping analyze academic papers and research. "
                "Answer the user's question based ONLY on the provided sources. "
                "Cite sources using [1], [2], etc. notation. "
                "If the sources don't contain enough information to answer, say so."
            )

            user_prompt = f"""Based on the following sources from my Zotero library, please answer this question:

**Question:** {query}

**Sources:**
{sources_text}

Please provide a well-structured answer with source citations."""

            # Step 3: Call the LLM
            answer = self._call_llm(
                system_prompt, user_prompt, provider, model, api_key
            )

            # Step 4: Format response with source references
            source_refs = [
                {
                    "title": s["title"],
                    "item_key": s.get("item_key", ""),
                    "location": s.get("location", ""),
                }
                for s in context_texts
            ]

            self._send_json({
                "answer": answer,
                "sources": source_refs,
                "provider": provider or "default",
            })

        except Exception as e:
            logger.error(f"Chat error: {e}\n{traceback.format_exc()}")
            self._send_error(500, f"Chat failed: {e}")

    def _handle_index_update(self, body: dict):
        """Trigger index update."""
        try:
            search = self._get_search()
            force = body.get("force_rebuild", False)
            fulltext = body.get("fulltext", False)

            stats = search.update_database(
                force_full_rebuild=force, extract_fulltext=fulltext
            )
            self._send_json(stats)
        except Exception as e:
            logger.error(f"Index update error: {e}")
            self._send_error(500, f"Index update failed: {e}")

    def _handle_find_similar(self, body: dict):
        """Find items similar to a given item."""
        item_key = body.get("item_key", "").strip()
        limit = body.get("limit", 10)

        if not item_key:
            self._send_error(400, "item_key is required")
            return

        try:
            zot = get_zotero_client()
            item = zot.item(item_key)
            data = item.get("data", {})
            query = f"{data.get('title', '')} {data.get('abstractNote', '')}"

            search = self._get_search()
            results = search.search(query=query, limit=limit + 1)

            # Filter out the source item itself
            similar = [
                {
                    "item_key": r.get("item_key", ""),
                    "title": r.get("metadata", {}).get("title", "Untitled"),
                    "score": r.get("similarity_score", 0),
                    "creators": r.get("metadata", {}).get("creators", ""),
                }
                for r in results.get("results", [])
                if r.get("item_key") != item_key
            ][:limit]

            self._send_json({"results": similar, "source_item": item_key})

        except Exception as e:
            self._send_error(500, f"Find similar failed: {e}")

    def _handle_summarize(self, body: dict):
        """Generate a summary of one or more items."""
        item_keys = body.get("item_keys", [])
        provider = body.get("provider", "")
        model = body.get("model", "")
        api_key = body.get("api_key", "")

        if not item_keys:
            self._send_error(400, "item_keys is required")
            return

        try:
            zot = get_zotero_client()
            texts = []
            for key in item_keys[:10]:  # Limit to 10 items
                item = zot.item(key)
                data = item.get("data", {})
                title = data.get("title", "Untitled")
                abstract = data.get("abstractNote", "")
                texts.append(f"**{title}**\n{abstract}")

            combined = "\n\n---\n\n".join(texts)

            system_prompt = (
                "You are a research assistant. Provide a concise, well-structured "
                "summary of the following academic papers. Identify key themes, "
                "methodology, and findings."
            )

            answer = self._call_llm(
                system_prompt,
                f"Please summarize these papers:\n\n{combined}",
                provider,
                model,
                api_key,
            )

            self._send_json({"summary": answer, "item_count": len(item_keys)})

        except Exception as e:
            self._send_error(500, f"Summarize failed: {e}")

    # ─── Context Gathering ────────────────────────────────────

    def _gather_context(
        self, context: dict, query: str
    ) -> list[dict[str, str]]:
        """Gather text from items based on context specification."""
        zot = get_zotero_client()
        sources = []

        if context.get("type") == "items":
            item_keys = context.get("item_keys", [])
            for key in item_keys[:20]:
                try:
                    item = zot.item(key)
                    data = item.get("data", {})
                    text = self._extract_item_text(data)
                    sources.append({
                        "title": data.get("title", "Untitled"),
                        "text": text,
                        "item_key": key,
                    })
                except Exception as e:
                    logger.warning(f"Could not fetch item {key}: {e}")

        elif context.get("type") == "collection":
            collection_key = context.get("collection_key", "")
            if collection_key:
                try:
                    items = zot.collection_items(collection_key, limit=20)
                    for item in items:
                        data = item.get("data", {})
                        if data.get("itemType") in ("attachment", "note"):
                            continue
                        text = self._extract_item_text(data)
                        sources.append({
                            "title": data.get("title", "Untitled"),
                            "text": text,
                            "item_key": item.get("key", ""),
                        })
                except Exception as e:
                    logger.warning(f"Could not fetch collection: {e}")

        else:
            # Library-wide: use semantic search to find relevant items
            try:
                search = self._get_search()
                results = search.search(query=query, limit=10)
                for r in results.get("results", []):
                    zotero_item = r.get("zotero_item", {})
                    data = zotero_item.get("data", {}) if zotero_item else {}
                    sources.append({
                        "title": data.get("title", r.get("metadata", {}).get("title", "Untitled")),
                        "text": self._extract_item_text(data) if data else r.get("matched_text", ""),
                        "item_key": r.get("item_key", ""),
                    })
            except Exception as e:
                logger.warning(f"Semantic context gathering failed: {e}")

        return sources

    def _extract_item_text(self, data: dict) -> str:
        """Extract readable text from a Zotero item's data."""
        parts = []
        if title := data.get("title"):
            parts.append(f"Title: {title}")
        if abstract := data.get("abstractNote"):
            parts.append(f"Abstract: {abstract}")
        if creators := data.get("creators"):
            parts.append(f"Authors: {format_creators(creators)}")
        if date := data.get("date"):
            parts.append(f"Date: {date}")
        if pub := data.get("publicationTitle"):
            parts.append(f"Published in: {pub}")
        return "\n".join(parts)

    # ─── LLM Integration ─────────────────────────────────────

    def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        provider: str = "",
        model: str = "",
        api_key: str = "",
    ) -> str:
        """
        Call an LLM provider. Supports multiple providers.

        Tries providers in order: specified provider, then falls back.
        """
        # Determine provider
        if not provider:
            # Auto-detect based on available API keys
            if os.environ.get("ANTHROPIC_API_KEY") or api_key:
                provider = "anthropic"
            elif os.environ.get("OPENAI_API_KEY"):
                provider = "openai"
            elif os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
                provider = "google"
            else:
                provider = "ollama"

        if provider == "anthropic":
            return self._call_anthropic(system_prompt, user_prompt, model, api_key)
        elif provider == "openai":
            return self._call_openai(system_prompt, user_prompt, model, api_key)
        elif provider == "google":
            return self._call_google(system_prompt, user_prompt, model, api_key)
        elif provider == "ollama":
            return self._call_ollama(system_prompt, user_prompt, model)
        else:
            raise ValueError(f"Unknown LLM provider: {provider}")

    def _call_anthropic(
        self, system: str, user: str, model: str = "", api_key: str = ""
    ) -> str:
        """Call Anthropic Claude API."""
        try:
            import anthropic

            key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
            if not key:
                raise ValueError(
                    "ANTHROPIC_API_KEY not set. Set it in environment or plugin preferences."
                )

            client = anthropic.Anthropic(api_key=key)
            response = client.messages.create(
                model=model or "claude-sonnet-4-20250514",
                max_tokens=4096,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text

        except ImportError:
            raise ValueError(
                "anthropic package not installed. Run: pip install anthropic"
            )

    def _call_openai(
        self, system: str, user: str, model: str = "", api_key: str = ""
    ) -> str:
        """Call OpenAI API."""
        try:
            from openai import OpenAI

            key = api_key or os.environ.get("OPENAI_API_KEY", "")
            if not key:
                raise ValueError("OPENAI_API_KEY not set")

            client = OpenAI(api_key=key)
            response = client.chat.completions.create(
                model=model or "gpt-4o",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                max_tokens=4096,
            )
            return response.choices[0].message.content

        except ImportError:
            raise ValueError(
                "openai package not installed. Run: pip install openai"
            )

    def _call_google(
        self, system: str, user: str, model: str = "", api_key: str = ""
    ) -> str:
        """Call Google Gemini API."""
        try:
            from google import genai

            key = (
                api_key
                or os.environ.get("GEMINI_API_KEY", "")
                or os.environ.get("GOOGLE_API_KEY", "")
            )
            if not key:
                raise ValueError("GEMINI_API_KEY not set")

            client = genai.Client(api_key=key)
            response = client.models.generate_content(
                model=model or "gemini-2.0-flash",
                contents=f"{system}\n\n{user}",
            )
            return response.text

        except ImportError:
            raise ValueError(
                "google-genai package not installed. Run: pip install google-genai"
            )

    def _call_ollama(
        self, system: str, user: str, model: str = ""
    ) -> str:
        """Call local Ollama instance."""
        import urllib.request

        ollama_model = model or "llama3.2"
        url = os.environ.get("OLLAMA_HOST", "http://localhost:11434") + "/api/chat"

        payload = json.dumps({
            "model": ollama_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
        }).encode()

        req = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json"}
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read())
                return result.get("message", {}).get("content", "")
        except Exception as e:
            raise ValueError(
                f"Ollama error (is it running?): {e}. "
                f"Install Ollama from https://ollama.ai and run: ollama pull {ollama_model}"
            )

    # ─── Helpers ──────────────────────────────────────────────

    def _get_search(self) -> ZoteroSemanticSearch:
        """Get or create semantic search instance."""
        if self.semantic_search is None:
            config_path = self.config_path or str(
                Path.home() / ".config" / "zotero-mcp" / "config.json"
            )
            PluginAPIHandler.semantic_search = create_semantic_search(config_path)
        return self.semantic_search

    def _read_body(self) -> dict:
        """Read and parse JSON request body."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length)
        return json.loads(body.decode("utf-8"))

    def _send_json(self, data: Any, status: int = 200):
        """Send a JSON response."""
        self.send_response(status)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _send_error(self, status: int, message: str):
        """Send an error response."""
        self._send_json({"error": message}, status=status)

    def _set_cors_headers(self):
        """Set CORS headers to allow requests from Zotero plugin."""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def log_message(self, format, *args):
        """Override to use our logger instead of stderr."""
        logger.info(format % args)


def start_plugin_api(
    host: str = "127.0.0.1",
    port: int = 9090,
    config_path: str | None = None,
) -> HTTPServer:
    """
    Start the plugin API HTTP server.

    Args:
        host: Host to bind to (default: 127.0.0.1 for security)
        port: Port to listen on (default: 9090)
        config_path: Path to zotero-mcp config file

    Returns:
        The running HTTPServer instance
    """
    PluginAPIHandler.config_path = config_path

    server = HTTPServer((host, port), PluginAPIHandler)
    logger.info(f"Plugin API server starting on {host}:{port}")
    sys.stderr.write(f"Plugin API server running on http://{host}:{port}\n")
    sys.stderr.write(f"Endpoints:\n")
    sys.stderr.write(f"  GET  /api/health       - Health check\n")
    sys.stderr.write(f"  GET  /api/status       - Index status\n")
    sys.stderr.write(f"  POST /api/search       - Semantic/hybrid search\n")
    sys.stderr.write(f"  POST /api/chat         - AI research assistant\n")
    sys.stderr.write(f"  POST /api/index/update  - Update search index\n")
    sys.stderr.write(f"  POST /api/similar      - Find similar items\n")
    sys.stderr.write(f"  POST /api/summarize    - Summarize items\n")

    return server


def run_plugin_api(
    host: str = "127.0.0.1",
    port: int = 9090,
    config_path: str | None = None,
):
    """Start and run the plugin API server (blocking)."""
    server = start_plugin_api(host, port, config_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nShutting down plugin API server...\n")
        server.shutdown()
