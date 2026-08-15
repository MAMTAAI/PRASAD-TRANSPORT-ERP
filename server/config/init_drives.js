// server/config/init_drives.js
// ─────────────────────────────────────────────────────────────────────────────
// Local storage isolation — boot-time drive/directory initialization.
//
// WHY. Heavy document traffic (vehicle docs, credit bills, IOCL PDFs, OCR
// scans) must not fill the OS drive. When LOCAL_STORAGE_PATH points at a
// dedicated volume (F:/Prasad_Transport_Data on the office PC), this module
// verifies the volume actually exists, lays out the directory tree, and fills
// in every downstream storage env var that the operator has not set explicitly.
//
// IMPORT ORDER MATTERS. server/lib/storage.js and services/ocrAutoFiler.js
// capture their env at module load — index.js therefore imports this module
// immediately after dotenv and before any route module.
//
// CROSS-PLATFORM CONTRACT.
//   LOCAL_STORAGE_PATH unset  → nothing changes: uploads/ and logs/ stay
//                               relative to the repo (exactly the AWS layout).
//   set but volume missing    → REFUSE TO BOOT. Falling back silently would
//                               scatter documents across two roots — the
//                               split-brain that S3-vs-local already taught us
//                               to fear. Fail at boot, not at first upload.
//
//   node server/config/init_drives.js     standalone: initialize + report
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'; // self-sufficient standalone; a no-op when index.js loaded it first
import { existsSync, mkdirSync } from 'node:fs';
import { parse, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBDIRS = ['uploads', 'logs', 'cache', 'temp_bills', join('uploads', 'scans')];

export function initDrives({ log = console } = {}) {
  const configured = process.env.LOCAL_STORAGE_PATH?.trim();
  const root = configured ? resolve(configured) : resolve(process.cwd());

  if (configured) {
    // On Windows this is the drive root (F:\); on POSIX it is '/'. The volume
    // must pre-exist — an unplugged disk must stop the boot, not be recreated
    // as an empty folder on the wrong drive.
    const volume = parse(root).root;
    if (!existsSync(volume)) {
      throw new Error(
        `[init_drives] LOCAL_STORAGE_PATH=${configured} but volume ${volume} does not exist — ` +
        'is the drive connected? Refusing to boot rather than writing documents to the wrong disk.');
    }
  }

  for (const sub of SUBDIRS) mkdirSync(join(root, sub), { recursive: true });

  // Fill only what the operator left unset — an explicit env var always wins.
  const derived = {
    UPLOAD_DIR: join(root, 'uploads'),
    OCR_UPLOAD_DIR: join(root, 'uploads', 'scans'),
    LOG_DIR: join(root, 'logs'),
    CACHE_DIR: join(root, 'cache'),
    TEMP_BILLS_DIR: join(root, 'temp_bills'),
  };
  const applied = {};
  for (const [key, value] of Object.entries(derived)) {
    if (!process.env[key]?.trim()) { process.env[key] = value; applied[key] = value; }
  }

  const report = {
    storage_root: root,
    isolated: !!configured,
    dirs: SUBDIRS.map((s) => join(root, s)),
    env_applied: applied,
    env_respected: Object.keys(derived).filter((k) => !(k in applied)),
  };
  log.info?.(`[init_drives] storage root ${root}${configured ? ' (isolated volume)' : ' (repo-local)'}`);
  return report;
}

// Side-effect on import (index.js) AND runnable standalone with a report.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const report = initDrives();
if (invokedDirectly) console.log(JSON.stringify(report, null, 2));

export default report;
