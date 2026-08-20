/**
 * @agentic/tools/metaerp — Meta ERP operation-catalog client used by
 * ontology-compiled agents (see docs/redesign-ontology-execution-2026-08-19.md §G1).
 */
export {
  metaerpInvoke,
  loadMetaerpCatalog,
  _clearMetaerpCatalogCacheForTests,
  type MetaerpCatalogOperation,
  type MetaerpOperationKind,
} from "./invoke";
