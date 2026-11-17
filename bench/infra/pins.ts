// Backend pins and HAPI settings. compose.yaml and hapi/application.yaml must agree.
import { join } from 'node:path';
import { BENCH, type LoadDatasetId } from '../lib/paths.js';

export const COMPOSE_PROJECT = 'fbbench';
export const INFRA_DIR = join(BENCH, 'infra');
export const COMPOSE_FILE = join(INFRA_DIR, 'compose.yaml');
export const HAPI_APPLICATION_YAML = join(INFRA_DIR, 'hapi', 'application.yaml');

export const IMAGES = {
  hapi: 'hapiproject/hapi:v8.12.0-2@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e',
  // PostgreSQL 17.12 (PG_VERSION 17.12-1.pgdg12+1), multi-arch index digest.
  postgres: 'postgres:17.12-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536',
} as const;

export const pgVolume = (d: LoadDatasetId) => `fbbench-pg-${d}`;

/** Values set in hapi/application.yaml and compose.yaml, recorded in manifests/infra.json. Keys are starter v8.12.0-2 AppProperties. */
export const HAPI_SETTINGS = {
  'hapi.fhir.server_address': null, // unset: HAPI builds its base from the request Host header
  'hapi.fhir.use_apache_address_strategy': false,
  'hapi.fhir.reuse_cached_search_results_millis': 0,
  'hapi.fhir.default_page_size': 20,
  'hapi.fhir.max_page_size': 200,
  // The starter maps retain_cached_searches_mins to JpaStorageSettings.expireSearchResultsAfterMillis.
  'hapi.fhir.retain_cached_searches_mins': 60,
  'expire_search_results_after_millis (derived)': 3_600_000,
  // Stock is 13,503,2003,-1. The starter sets fetchSizeDefaultMaximum = max_page_size, which caps the -1 pass and
  // silently truncated every search with more than ~2,203 matches (observed on HAPI 8.12.0). Last threshold > any dataset.
  'hapi.fhir.search_prefetch_thresholds': '13,503,2003,2000000',
  'fetch_size_default_maximum (derived from max_page_size by the starter)': 200,
  'hapi.fhir.client_id_strategy': 'ALPHANUMERIC',
  'hapi.fhir.enforce_referential_integrity_on_write': false,
  'hapi.fhir.enforce_referential_integrity_on_delete': false,
  'hapi.fhir.auto_create_placeholder_reference_targets': false,
  // No starter key exists for JpaStorageSettings.defaultTotalMode in v8.12.0-2; it stays at HAPI's default.
  // The served behaviour is probed after load and recorded in manifests/load-<dataset>.json (hapi_effective).
  'Bundle.total mode': 'HAPI default (no starter key)',
  'spring.jpa.properties.hibernate.dialect': 'ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect',
} as const;

export const JVM_OPTIONS = '-Xms1g -Xmx4g';
export const POSTGRES_ARGS = [
  '-c', 'shared_buffers=1GB',
  '-c', 'max_wal_size=8GB',
  '-c', 'checkpoint_timeout=15min',
  '-c', 'max_connections=50',
] as const;
