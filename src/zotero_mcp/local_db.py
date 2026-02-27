"""
Local Zotero database reader for semantic search.

Provides direct SQLite access to Zotero's local database for faster semantic search
when running in local mode.
"""

import os
import sqlite3
import platform
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass

from .utils import is_local_mode


@dataclass
class ZoteroItem:
    """Represents a Zotero item with text content for semantic search."""
    item_id: int
    key: str
    item_type_id: int
    item_type: str | None = None
    doi: str | None = None
    title: str | None = None
    abstract: str | None = None
    creators: str | None = None
    fulltext: str | None = None
    fulltext_source: str | None = None  # 'pdf' or 'html'
    notes: str | None = None
    extra: str | None = None
    date_added: str | None = None
    date_modified: str | None = None

    def get_searchable_text(self) -> str:
        """
        Combine all text fields into a single searchable string.

        Returns:
            Combined text content for semantic search indexing.
        """
        parts = []

        if self.title:
            parts.append(f"Title: {self.title}")

        if self.creators:
            parts.append(f"Authors: {self.creators}")

        if self.abstract:
            parts.append(f"Abstract: {self.abstract}")

        if self.extra:
            parts.append(f"Extra: {self.extra}")

        if self.notes:
            parts.append(f"Notes: {self.notes}")

        if self.fulltext:
            # Truncate fulltext to avoid overly long documents
            truncated_fulltext = self.fulltext[:5000] + "..." if len(self.fulltext) > 5000 else self.fulltext
            parts.append(f"Content: {truncated_fulltext}")

        return "\n\n".join(parts)


class LocalZoteroReader:
    """
    Direct SQLite reader for Zotero's local database.

    Provides fast access to item metadata and fulltext for semantic search
    without going through the Zotero API.
    """

    def __init__(self, db_path: str | None = None, pdf_max_pages: int | None = None):
        """
        Initialize the local database reader.

        Args:
            db_path: Optional path to zotero.sqlite. If None, auto-detect.
        """
        self.db_path = db_path or self._find_zotero_db()
        self._connection: sqlite3.Connection | None = None
        self.pdf_max_pages: int | None = pdf_max_pages
        # Reduce noise from pdfminer warnings
        try:
            logging.getLogger("pdfminer").setLevel(logging.ERROR)
        except Exception:
            pass

    def _find_zotero_db(self) -> str:
        """
        Auto-detect the Zotero database location based on OS.

        Returns:
            Path to zotero.sqlite file.

        Raises:
            FileNotFoundError: If database cannot be located.
        """
        system = platform.system()

        if system == "Darwin":  # macOS
            db_path = Path.home() / "Zotero" / "zotero.sqlite"
        elif system == "Windows":
            # Try Windows 7+ location first
            db_path = Path.home() / "Zotero" / "zotero.sqlite"
            if not db_path.exists():
                # Fallback to XP/2000 location
                db_path = Path(os.path.expanduser("~/Documents and Settings")) / os.getenv("USERNAME", "") / "Zotero" / "zotero.sqlite"
        else:  # Linux and others
            db_path = Path.home() / "Zotero" / "zotero.sqlite"

        if not db_path.exists():
            raise FileNotFoundError(
                f"Zotero database not found at {db_path}. "
                "Please ensure Zotero is installed and has been run at least once."
            )

        return str(db_path)

    def _get_connection(self) -> sqlite3.Connection:
        """Get database connection, creating if needed."""
        if self._connection is None:
            # Open in read-only mode for safety
            uri = f"file:{self.db_path}?mode=ro"
            self._connection = sqlite3.connect(uri, uri=True)
            self._connection.row_factory = sqlite3.Row
        return self._connection

    def _get_storage_dir(self) -> Path:
        """Return the Zotero storage directory path based on database location."""
        # Infer storage directory from database path (same parent directory)
        db_parent = Path(self.db_path).parent
        return db_parent / "storage"

    def _iter_parent_attachments(self, parent_item_id: int):
        """Yield tuples (attachment_key, path, content_type) for a parent item."""
        conn = self._get_connection()
        query = (
            """
            SELECT ia.itemID as attachmentItemID,
                   ia.parentItemID as parentItemID,
                   ia.path as path,
                   ia.contentType as contentType,
                   att.key as attachmentKey
            FROM itemAttachments ia
            JOIN items att ON att.itemID = ia.itemID
            WHERE ia.parentItemID = ?
            """
        )
        for row in conn.execute(query, (parent_item_id,)):
            yield row["attachmentKey"], row["path"], row["contentType"]

    def _resolve_attachment_path(self, attachment_key: str, zotero_path: str) -> Path | None:
        """Resolve a Zotero attachment path like 'storage:filename.pdf' to a filesystem path."""
        if not zotero_path:
            return None
        storage_dir = self._get_storage_dir()
        if zotero_path.startswith("storage:"):
            rel = zotero_path.split(":", 1)[1]
            # Handle nested paths if present
            parts = [p for p in rel.split("/") if p]
            return storage_dir / attachment_key / Path(*parts)
        # External links not supported in first pass
        return None

    def _get_pdf_max_pages(self) -> int:
        """Determine the PDF page cap from config, env, or default."""
        if isinstance(self.pdf_max_pages, int) and self.pdf_max_pages > 0:
            return self.pdf_max_pages
        max_pages_env = os.getenv("ZOTERO_PDF_MAXPAGES")
        try:
            return int(max_pages_env) if max_pages_env else 10
        except ValueError:
            return 10

    def _extract_text_from_pdf(self, file_path: Path) -> str:
        """Extract text from a PDF, with OCR fallback for scanned documents.

        Pipeline:
        1. Try pdfminer (fast, native text extraction)
        2. If result is too short (likely scanned), try PyMuPDF (fitz) + OCR
        3. If still empty, try MarkItDown as last resort
        """
        maxpages = self._get_pdf_max_pages()

        # Step 1: pdfminer (fast, works well for native-text PDFs)
        text = self._extract_pdf_pdfminer(file_path, maxpages)
        if text and len(text.strip()) > 50:
            return text

        # Step 2: PyMuPDF (fitz) — can extract text + do OCR if Tesseract is available
        text = self._extract_pdf_pymupdf(file_path, maxpages)
        if text and len(text.strip()) > 50:
            return text

        # Step 3: MarkItDown fallback
        text = self._extract_pdf_markitdown(file_path)
        if text and len(text.strip()) > 50:
            return text

        # Return whatever we got (even if short)
        return text or ""

    def _extract_pdf_pdfminer(self, file_path: Path, maxpages: int) -> str:
        """Extract text using pdfminer (fast, text-layer only)."""
        try:
            from pdfminer.high_level import extract_text  # type: ignore
            text = extract_text(str(file_path), maxpages=maxpages)
            return text or ""
        except Exception:
            return ""

    def _extract_pdf_pymupdf(self, file_path: Path, maxpages: int) -> str:
        """Extract text using PyMuPDF (fitz). Supports OCR when Tesseract is installed.

        Also extracts image alt-text/descriptions when possible.
        """
        try:
            import fitz  # type: ignore  # PyMuPDF
        except ImportError:
            return ""

        try:
            doc = fitz.open(str(file_path))
            text_parts = []
            pages_to_read = min(len(doc), maxpages)

            for page_num in range(pages_to_read):
                page = doc[page_num]

                # Try regular text extraction first
                page_text = page.get_text()

                # If page has very little text, try OCR
                if len(page_text.strip()) < 20:
                    try:
                        # PyMuPDF can do OCR if Tesseract is available
                        page_text = page.get_text("text", flags=fitz.TEXT_PRESERVE_WHITESPACE)
                        if len(page_text.strip()) < 20:
                            # Try the OCR text page method
                            tp = page.get_textpage_ocr(flags=0, full=True)
                            page_text = page.get_text("text", textpage=tp)
                    except Exception:
                        pass  # OCR not available, use what we have

                if page_text.strip():
                    text_parts.append(page_text)

            doc.close()
            return "\n".join(text_parts)
        except Exception:
            return ""

    def _extract_pdf_markitdown(self, file_path: Path) -> str:
        """Extract text using MarkItDown as a last resort."""
        try:
            from markitdown import MarkItDown  # type: ignore
            md = MarkItDown()
            result = md.convert(str(file_path))
            return result.text_content or ""
        except Exception:
            return ""

    def _extract_text_from_html(self, file_path: Path) -> str:
        """Extract text from HTML using markitdown if available; fallback to stripping tags."""
        # Try markitdown first
        try:
            from markitdown import MarkItDown
            md = MarkItDown()
            result = md.convert(str(file_path))
            return result.text_content or ""
        except Exception:
            pass
        # Fallback using a simple parser
        try:
            from bs4 import BeautifulSoup  # type: ignore
            html = file_path.read_text(errors="ignore")
            return BeautifulSoup(html, "html.parser").get_text(" ")
        except Exception:
            return ""

    def _extract_text_from_file(self, file_path: Path) -> str:
        """Extract text content from a file based on extension, with fallbacks."""
        suffix = file_path.suffix.lower()
        if suffix == ".pdf":
            return self._extract_text_from_pdf(file_path)
        if suffix in {".html", ".htm"}:
            return self._extract_text_from_html(file_path)
        # Generic best-effort
        try:
            return file_path.read_text(errors="ignore")
        except Exception:
            return ""

    def _get_fulltext_meta_for_item(self, item_id: int):
        meta = []
        for key, path, ctype in self._iter_parent_attachments(item_id):
            meta.append([key, path, ctype])

        return meta

    def _extract_image_descriptions_from_pdf(self, file_path: Path, max_images: int = 10) -> list[str]:
        """Extract text descriptions of images in a PDF using PyMuPDF.

        For each significant image, extracts any associated alt-text, caption text nearby,
        and basic metadata (size, page number). This makes image content discoverable
        via text-based semantic search.

        Args:
            file_path: Path to the PDF file.
            max_images: Maximum number of images to describe.

        Returns:
            List of image description strings.
        """
        try:
            import fitz  # type: ignore  # PyMuPDF
        except ImportError:
            return []

        descriptions = []
        try:
            doc = fitz.open(str(file_path))
            maxpages = self._get_pdf_max_pages()
            pages_to_read = min(len(doc), maxpages)
            image_count = 0

            for page_num in range(pages_to_read):
                if image_count >= max_images:
                    break

                page = doc[page_num]
                image_list = page.get_images(full=True)

                for img_info in image_list:
                    if image_count >= max_images:
                        break

                    xref = img_info[0]
                    try:
                        # Get image dimensions
                        base_image = doc.extract_image(xref)
                        if not base_image:
                            continue

                        width = base_image.get("width", 0)
                        height = base_image.get("height", 0)

                        # Skip tiny images (icons, decorations)
                        if width < 100 or height < 100:
                            continue

                        # Try to get nearby text as context/caption
                        # Look for text blocks near the image location
                        img_rects = page.get_image_rects(xref)
                        caption_text = ""
                        if img_rects:
                            img_rect = img_rects[0]
                            # Look for text below the image (common caption position)
                            caption_rect = fitz.Rect(
                                img_rect.x0,
                                img_rect.y1,
                                img_rect.x1,
                                min(img_rect.y1 + 50, page.rect.height)
                            )
                            caption_text = page.get_text("text", clip=caption_rect).strip()

                        desc = f"[Figure on page {page_num + 1}, {width}x{height}px"
                        if caption_text:
                            desc += f": {caption_text[:200]}"
                        desc += "]"

                        descriptions.append(desc)
                        image_count += 1

                    except Exception:
                        continue

            doc.close()
        except Exception:
            pass

        return descriptions

    def _extract_fulltext_for_item(self, item_id: int) -> tuple[str, str] | None:
        """Attempt to extract fulltext and source from the item's best attachment.

        Preference: use PDF when available; fall back to HTML when no PDF exists.
        For PDFs, also extracts image descriptions to make figures searchable.
        Returns (text, source) where source is 'pdf', 'pdf+ocr', or 'html'.
        """
        best_pdf = None
        best_html = None
        for key, path, ctype in self._iter_parent_attachments(item_id):
            resolved = self._resolve_attachment_path(key, path or "")
            if not resolved or not resolved.exists():
                continue
            if ctype == "application/pdf" and best_pdf is None:
                best_pdf = resolved
            elif (ctype or "").startswith("text/html") and best_html is None:
                best_html = resolved
        # Prefer PDF, otherwise fall back to HTML
        target = best_pdf or best_html
        if not target:
            return None
        text = self._extract_text_from_file(target)

        source = "pdf" if target.suffix.lower() == ".pdf" else ("html" if target.suffix.lower() in {".html", ".htm"} else "file")

        # For PDFs, also extract image descriptions
        if target.suffix.lower() == ".pdf":
            image_descs = self._extract_image_descriptions_from_pdf(target)
            if image_descs:
                image_section = "\n\n[Figures/Images in document]\n" + "\n".join(image_descs)
                text = (text or "") + image_section
            # If we got text via OCR (pdfminer returned empty but pymupdf worked), note it
            if not self._extract_pdf_pdfminer(target, self._get_pdf_max_pages()).strip():
                source = "pdf+ocr"

        if not text:
            return None
        # Truncate to keep embeddings reasonable
        return (text[:10000], source)

    def close(self):
        """Close database connection."""
        if self._connection:
            self._connection.close()
            self._connection = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def get_item_count(self) -> int:
        """
        Get total count of non-attachment items.

        Returns:
            Number of items in the library.
        """
        conn = self._get_connection()
        cursor = conn.execute(
            """
            SELECT COUNT(*)
            FROM items i
            JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
            WHERE it.typeName NOT IN ('attachment', 'note', 'annotation')
            """
        )
        return cursor.fetchone()[0]

    def get_items_with_text(self, limit: int | None = None, include_fulltext: bool = False) -> list[ZoteroItem]:
        """
        Get all items with their text content for semantic search.

        Args:
            limit: Optional limit on number of items to return.

        Returns:
            List of ZoteroItem objects with text content.
        """
        conn = self._get_connection()

        # Query to get items with their text content (simplified for now)
        query = """
        SELECT
            i.itemID,
            i.key,
            i.itemTypeID,
            it.typeName as item_type,
            i.dateAdded,
            i.dateModified,
            title_val.value as title,
            abstract_val.value as abstract,
            extra_val.value as extra,
            doi_val.value as doi,
            GROUP_CONCAT(n.note, ' ') as notes,
            GROUP_CONCAT(
                CASE
                    WHEN c.firstName IS NOT NULL AND c.lastName IS NOT NULL
                    THEN c.lastName || ', ' || c.firstName
                    WHEN c.lastName IS NOT NULL
                    THEN c.lastName
                    ELSE NULL
                END, '; '
            ) as creators
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID

        -- Get title
        LEFT JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID = 1
        LEFT JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID

        -- Get abstract
        LEFT JOIN itemData abstract_data ON i.itemID = abstract_data.itemID AND abstract_data.fieldID = 2
        LEFT JOIN itemDataValues abstract_val ON abstract_data.valueID = abstract_val.valueID

        -- Get extra field
        LEFT JOIN itemData extra_data ON i.itemID = extra_data.itemID AND extra_data.fieldID = 16
        LEFT JOIN itemDataValues extra_val ON extra_data.valueID = extra_val.valueID

        -- Get DOI field via fields table
        LEFT JOIN fields doi_f ON doi_f.fieldName = 'DOI'
        LEFT JOIN itemData doi_data ON i.itemID = doi_data.itemID AND doi_data.fieldID = doi_f.fieldID
        LEFT JOIN itemDataValues doi_val ON doi_data.valueID = doi_val.valueID

        -- Get notes
        LEFT JOIN itemNotes n ON i.itemID = n.parentItemID OR i.itemID = n.itemID

        -- Get creators
        LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
        LEFT JOIN creators c ON ic.creatorID = c.creatorID

        WHERE it.typeName NOT IN ('attachment', 'note', 'annotation')

        GROUP BY i.itemID, i.key, i.itemTypeID, it.typeName, i.dateAdded, i.dateModified,
                 title_val.value, abstract_val.value, extra_val.value

        ORDER BY i.dateModified DESC
        """

        if limit:
            query += f" LIMIT {limit}"

        cursor = conn.execute(query)
        items = []

        for row in cursor:
            item = ZoteroItem(
                item_id=row['itemID'],
                key=row['key'],
                item_type_id=row['itemTypeID'],
                item_type=row['item_type'],
                doi=row['doi'],
                title=row['title'],
                abstract=row['abstract'],
                creators=row['creators'],
                fulltext=(res := (self._extract_fulltext_for_item(row['itemID']) if include_fulltext else None)) and res[0],
                fulltext_source=res[1] if include_fulltext and res else None,
                notes=row['notes'],
                extra=row['extra'],
                date_added=row['dateAdded'],
                date_modified=row['dateModified']
            )
            items.append(item)

        return items

    # Public helper to quickly check full text metadata for item
    def get_fulltext_meta_for_item(self, item_id: int) -> tuple[str, str] | None:
        return self._get_fulltext_meta_for_item(item_id)

    # Public helper to extract fulltext on demand for a specific item
    def extract_fulltext_for_item(self, item_id: int) -> tuple[str, str] | None:
        return self._extract_fulltext_for_item(item_id)

    def get_item_by_key(self, key: str, include_fulltext: bool = False) -> ZoteroItem | None:
        """
        Get a specific item by its Zotero key using a direct SQL query.

        Args:
            key: The Zotero item key.
            include_fulltext: Whether to extract fulltext content.

        Returns:
            ZoteroItem if found, None otherwise.
        """
        items = self.get_items_by_keys([key], include_fulltext=include_fulltext)
        return items[0] if items else None

    def get_items_by_keys(self, keys: list[str], include_fulltext: bool = False) -> list[ZoteroItem]:
        """
        Get specific items by their Zotero keys using a direct SQL query.

        Much faster than get_items_with_text() for small numbers of items
        since it only fetches the requested items instead of the entire library.

        Args:
            keys: List of Zotero item keys.
            include_fulltext: Whether to extract fulltext content.

        Returns:
            List of matching ZoteroItem objects.
        """
        if not keys:
            return []

        conn = self._get_connection()
        placeholders = ",".join("?" for _ in keys)

        query = f"""
        SELECT
            i.itemID,
            i.key,
            i.itemTypeID,
            it.typeName as item_type,
            i.dateAdded,
            i.dateModified,
            title_val.value as title,
            abstract_val.value as abstract,
            extra_val.value as extra,
            doi_val.value as doi,
            GROUP_CONCAT(n.note, ' ') as notes,
            GROUP_CONCAT(
                CASE
                    WHEN c.firstName IS NOT NULL AND c.lastName IS NOT NULL
                    THEN c.lastName || ', ' || c.firstName
                    WHEN c.lastName IS NOT NULL
                    THEN c.lastName
                    ELSE NULL
                END, '; '
            ) as creators
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
        LEFT JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID = 1
        LEFT JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
        LEFT JOIN itemData abstract_data ON i.itemID = abstract_data.itemID AND abstract_data.fieldID = 2
        LEFT JOIN itemDataValues abstract_val ON abstract_data.valueID = abstract_val.valueID
        LEFT JOIN itemData extra_data ON i.itemID = extra_data.itemID AND extra_data.fieldID = 16
        LEFT JOIN itemDataValues extra_val ON extra_data.valueID = extra_val.valueID
        LEFT JOIN fields doi_f ON doi_f.fieldName = 'DOI'
        LEFT JOIN itemData doi_data ON i.itemID = doi_data.itemID AND doi_data.fieldID = doi_f.fieldID
        LEFT JOIN itemDataValues doi_val ON doi_data.valueID = doi_val.valueID
        LEFT JOIN itemNotes n ON i.itemID = n.parentItemID OR i.itemID = n.itemID
        LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
        LEFT JOIN creators c ON ic.creatorID = c.creatorID
        WHERE i.key IN ({placeholders})
          AND it.typeName NOT IN ('attachment', 'note', 'annotation')
        GROUP BY i.itemID, i.key, i.itemTypeID, it.typeName, i.dateAdded, i.dateModified,
                 title_val.value, abstract_val.value, extra_val.value
        """

        cursor = conn.execute(query, keys)
        items = []

        for row in cursor:
            res = self._extract_fulltext_for_item(row['itemID']) if include_fulltext else None
            item = ZoteroItem(
                item_id=row['itemID'],
                key=row['key'],
                item_type_id=row['itemTypeID'],
                item_type=row['item_type'],
                doi=row['doi'],
                title=row['title'],
                abstract=row['abstract'],
                creators=row['creators'],
                fulltext=res[0] if res else None,
                fulltext_source=res[1] if res else None,
                notes=row['notes'],
                extra=row['extra'],
                date_added=row['dateAdded'],
                date_modified=row['dateModified']
            )
            items.append(item)

        return items

    def search_items_by_text(self, query: str, limit: int = 50) -> list[ZoteroItem]:
        """
        Simple text search through item content.

        Args:
            query: Search query string.
            limit: Maximum number of results.

        Returns:
            List of matching ZoteroItem objects.
        """
        items = self.get_items_with_text()
        matching_items = []

        query_lower = query.lower()

        for item in items:
            searchable_text = item.get_searchable_text().lower()
            if query_lower in searchable_text:
                matching_items.append(item)
                if len(matching_items) >= limit:
                    break

        return matching_items


def get_local_zotero_reader() -> LocalZoteroReader | None:
    """
    Get a LocalZoteroReader instance if in local mode.

    Returns:
        LocalZoteroReader instance if in local mode and database exists,
        None otherwise.
    """
    if not is_local_mode():
        return None

    try:
        return LocalZoteroReader()
    except FileNotFoundError:
        return None


def is_local_db_available() -> bool:
    """
    Check if local Zotero database is available.

    Returns:
        True if local database can be accessed, False otherwise.
    """
    reader = get_local_zotero_reader()
    if reader:
        reader.close()
        return True
    return False