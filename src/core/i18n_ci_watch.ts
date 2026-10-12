// The CI watcher's own catalog (odd/tasks/ci-watcher.md): the band row and the
// toast the person reads while a run is watched and when it ends. The note the
// agent reads is English on purpose (ciNoteText in ci_watch.ts) and is not here.
import type { Catalog } from "./i18n.ts";

export type CiWatchKey = "band.waiting" | "band.running" | "band.passed" | "band.failed";

export const CI_WATCH_CATALOG: Catalog<CiWatchKey> = {
  es: {
    "band.waiting": "CI {{label}}: esperando que aparezcan las ejecuciones, {{minutes}} min",
    "band.running": "CI {{label}}: en curso, {{done}} de {{total}} ejecuciones hechas, {{minutes}} min",
    "band.passed": "CI {{label}}: pasó",
    "band.failed": "CI {{label}}: falló{{workflows}}",
  },
  en: {
    "band.waiting": "CI {{label}}: waiting for the runs to appear, {{minutes}} min",
    "band.running": "CI {{label}}: running, {{done}} of {{total}} runs done, {{minutes}} min",
    "band.passed": "CI {{label}}: passed",
    "band.failed": "CI {{label}}: failed{{workflows}}",
  },
};
