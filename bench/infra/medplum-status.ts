// bench:medplum:status: Medplum containers and /healthcheck (exit 1 if Medplum is not healthy).
import { mustRun } from './manifest.js';
import { MEDPLUM_COMPOSE_PROJECT, MEDPLUM_FHIR_BASE, medplumHealth } from './medplum.js';

const ps = await mustRun('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${MEDPLUM_COMPOSE_PROJECT}`, '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}']);
const health = await medplumHealth();
process.stdout.write(JSON.stringify({ containers: ps.trim().split('\n').filter(Boolean), fhir_base: MEDPLUM_FHIR_BASE, health }, null, 2) + '\n');
process.exit(health?.ok === true ? 0 : 1);
