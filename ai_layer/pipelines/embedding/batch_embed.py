"""batch_embed.py — Initial bulk population of the Vertex AI Vector Search index.

Reads every group from Firestore, unnests embedded expenses (Phase 1 model),
builds embedding text (shared with the streaming pipeline via embedding_utils),
embeds in batches with Vertex `text-embedding-005`, and streaming-upserts
datapoints namespaced by participant uids + groupId.

Run once after `gcp_setup.sh` and before relying on RAG:

    GCP_PROJECT_ID=my-proj GCP_REGION=us-central1 \
    VECTOR_INDEX_ID=1234567890 EMBEDDING_MODEL=text-embedding-005 \
    GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
    python batch_embed.py

Idempotent: re-running re-upserts the same datapointIds (overwrite), so it is
safe to retry. Requires: google-cloud-firestore, google-cloud-aiplatform.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any

from google.cloud import firestore
from vertexai.language_models import TextEmbeddingModel, TextEmbeddingInput
import vertexai
from google.cloud import aiplatform_v1

from embedding_utils import build_embedding_text, allowed_uids

PROJECT = os.environ["GCP_PROJECT_ID"]
REGION = os.environ.get("GCP_REGION", "us-central1")
MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "text-embedding-005")
INDEX_ID = os.environ["VECTOR_INDEX_ID"]
BATCH = 100  # embedding requests per call


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    vertexai.init(project=PROJECT, location=REGION)
    model = TextEmbeddingModel.from_pretrained(MODEL_NAME)
    db = firestore.Client(project=PROJECT)
    index_client = aiplatform_v1.IndexServiceClient(
        client_options={"api_endpoint": f"{REGION}-aiplatform.googleapis.com"}
    )
    index_name = f"projects/{PROJECT}/locations/{REGION}/indexes/{INDEX_ID}"

    pending: list[dict[str, Any]] = []  # {id, text, restricts, numeric}
    total = 0

    for group in db.collection("groups").stream():
        g = group.to_dict() or {}
        gid = group.id
        currency = g.get("currency") or "USD"
        name_by_id = {m.get("userId"): m.get("displayName", "") for m in (g.get("members") or [])}

        for e in (g.get("expenses") or []):
            eid = e.get("expenseId")
            if not eid:
                continue
            uids = allowed_uids(e.get("paidBy"), e.get("participants") or [])
            participant_names = [
                name_by_id.get(p.get("userId"), "") for p in (e.get("participants") or [])
            ]
            text = build_embedding_text(
                title=e.get("title") or e.get("description"),
                category=e.get("category"),
                amount=e.get("amount"),
                currency=currency,
                notes=e.get("notes"),
                created_at_ms=e.get("createdAt"),
                participant_names=participant_names,
            )
            pending.append({
                "id": eid,
                "text": text,
                "restricts": [
                    {"namespace": "user", "allow_list": uids},
                    {"namespace": "group", "allow_list": [gid]},
                ],
                "numeric": [
                    {"namespace": "amount", "value_float": float(e.get("amount") or 0)},
                    {"namespace": "created_at_ms", "value_long": int(e.get("createdAt") or 0)},
                ],
            })

            if len(pending) >= BATCH:
                total += _flush(model, index_client, index_name, pending)
                pending = []

    if pending:
        total += _flush(model, index_client, index_name, pending)

    print(f"✅ Batch embed complete: upserted {total} datapoints.")


def _flush(model, index_client, index_name, batch: list[dict]) -> int:
    inputs = [TextEmbeddingInput(text=b["text"], task_type="RETRIEVAL_DOCUMENT") for b in batch]
    embeddings = model.get_embeddings(inputs)
    datapoints = []
    for b, emb in zip(batch, embeddings):
        datapoints.append(
            aiplatform_v1.IndexDatapoint(
                datapoint_id=b["id"],
                feature_vector=emb.values,
                restricts=[
                    aiplatform_v1.IndexDatapoint.Restriction(
                        namespace=r["namespace"], allow_list=r["allow_list"]
                    )
                    for r in b["restricts"]
                ],
                numeric_restricts=[
                    aiplatform_v1.IndexDatapoint.NumericRestriction(
                        namespace=n["namespace"],
                        **({"value_float": n["value_float"]} if "value_float" in n else {"value_long": n["value_long"]}),
                    )
                    for n in b["numeric"]
                ],
            )
        )
    index_client.upsert_datapoints(
        request=aiplatform_v1.UpsertDatapointsRequest(index=index_name, datapoints=datapoints)
    )
    return len(datapoints)


if __name__ == "__main__":
    main()
