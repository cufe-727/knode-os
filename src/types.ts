/** Shared domain types for knode-os. */

export type DocRoot = 'docs' | 'wiki' | 'skills' | 'traces';

export interface DocumentRow {
  id: string;
  path: string;
  root: DocRoot;
  title: string | null;
  sha256: string;
  mime: string | null;
  bytes: number;
  status: 'pending' | 'indexed' | 'error' | 'skipped';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  seq: number;
  content: string;
  token_count: number;
  metadata: Record<string, unknown>;
}

export interface EntityRow {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wiki_path: string | null;
  mention_count: number;
}

export interface RelationRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string;
  weight: number;
  document_id: string | null;
}

export interface TraceRow {
  id: string;
  source: 'claude' | 'codex';
  session_id: string | null;
  path: string;
  project: string | null;
  started_at: string | null;
  bytes: number;
  sha256: string;
  analyzed_at: string | null;
}

export interface SuggestionRow {
  id: string;
  kind: 'skill' | 'memory' | 'knowledge';
  title: string;
  body: string;
  evidence: string[];
  status: 'pending' | 'accepted' | 'rejected';
  report_path: string | null;
  created_at: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  path: string;
  title: string | null;
  content: string;
  score: number;
  signals: { vector?: number; keyword?: number; graph?: number };
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string;
  score: number;
  mentionCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  description: string;
  weight: number;
}

export interface GraphSearchResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: SearchResult[];
}

export interface IngestStats {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  chunks: number;
  entities: number;
  relations: number;
}
