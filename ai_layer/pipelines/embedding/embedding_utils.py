"""embedding_utils.py — Shared utilities for the batch embedding job.

Mirrors the pure logic in `embedding_client.ts` (`buildEmbeddingText`) so batch
and streaming pipelines embed identical text for the same expense. Also provides
text preprocessing and L2 normalization helpers.

PII (Critical Rule #3): structured email/phone fields are never included, and
free text (title/notes) is run through `redact_pii` before embedding in case
users typed contact details into it. Never log raw text.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# 9–15 digits with up to 2 separator chars between them (covers "+1 (415) 555-0199");
# the 9-digit floor keeps dates (8 digits) and amounts out of scope.
_PHONE_RE = re.compile(r"\+?(?:\d[\s\-().]{0,2}){8,14}\d")


def redact_pii(text: str) -> str:
    """Redact emails and phone-like sequences (mirrors redactPII in TS)."""
    return _PHONE_RE.sub("[phone]", _EMAIL_RE.sub("[email]", text))


def clean_text(value: Optional[str]) -> str:
    """Collapse whitespace and trim. Returns '' for None."""
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def build_embedding_text(
    *,
    title: Optional[str] = None,
    category: Optional[str] = None,
    amount: Optional[float] = None,
    currency: Optional[str] = None,
    notes: Optional[str] = None,
    created_at_ms: Optional[int] = None,
    participant_names: Optional[Iterable[str]] = None,
) -> str:
    """Build the compact, recall-friendly per-expense embedding text.

    Deterministic and side-effect free — matches buildEmbeddingText in TS.
    """
    parts: list[str] = []
    title = clean_text(title)
    if title:
        parts.append(redact_pii(title))
    category = clean_text(category)
    if category:
        parts.append(f"category: {category}")
    if amount is not None:
        parts.append(f"amount: {currency or ''}{amount:.2f}".strip())
    if created_at_ms:
        date = datetime.fromtimestamp(created_at_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        parts.append(f"date: {date}")
    names = [clean_text(n) for n in (participant_names or []) if clean_text(n)]
    if names:
        parts.append("with: " + ", ".join(names))
    notes = clean_text(notes)
    if notes:
        parts.append(f"notes: {redact_pii(notes)}")
    return " · ".join(parts)


def l2_normalize(vector: list[float]) -> list[float]:
    """L2-normalize a vector (no-op for zero vectors)."""
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0:
        return vector
    return [v / norm for v in vector]


def allowed_uids(paid_by: Optional[str], participants: Iterable[dict]) -> list[str]:
    """Compute the set of uids allowed to retrieve an expense (paid_by + participants)."""
    uids = {paid_by} if paid_by else set()
    for p in participants or []:
        uid = p.get("userId")
        if uid:
            uids.add(uid)
    return sorted(u for u in uids if u)
