/**
 * index.ts — Public entry for the SplitCircle AI layer.
 *
 * Re-exports the per-group ingestion cores that the consolidated `onGroupWritten`
 * orchestrator (in `functions/src/aiLayer.ts`) fans out to, plus the RAG query
 * service. Build this package and point `AI_LAYER_DIST` at the compiled output to
 * activate the orchestrator — see `functions/src/aiLayer.ts` and the README.
 */

export { runBqSyncForGroup, syncGroupToBigQuery } from './pipelines/firestore_to_bq/sync_function';
export { runEmbedForGroup, embedGroupExpenses } from './pipelines/embedding/embed_expenses';
export { runAutoCategorizeForGroup, autoCategorizeExpenses } from './models/category_classifier/predict_service';
export { queryExpenseRAG, parseDatapointId } from './services/rag/rag_service';
export type { RAGQuery, RAGResult, RAGDeps, ExpenseRef } from './services/rag/rag_service';
