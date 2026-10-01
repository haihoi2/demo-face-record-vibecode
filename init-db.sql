-- PostgreSQL schema initialization for SmartFace & Lock Gateway
-- Automatically executed when Postgres starts via docker-entrypoint-initdb.d

CREATE TABLE IF NOT EXISTS employees (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  "employeeCode" VARCHAR(64) UNIQUE NOT NULL,
  department VARCHAR(255),
  position VARCHAR(255),
  "photoUrl" TEXT,
  "registeredAt" VARCHAR(64),
  "accessLevel" VARCHAR(32) DEFAULT 'ALL_ACCESS'
);

CREATE TABLE IF NOT EXISTS access_logs (
  id VARCHAR(64) PRIMARY KEY,
  timestamp VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  "employeeId" VARCHAR(64),
  "employeeName" VARCHAR(255),
  "employeeCode" VARCHAR(64),
  department VARCHAR(255),
  "photoSnapshot" TEXT,
  confidence NUMERIC(5, 2),
  "livenessScore" NUMERIC(5, 2),
  "lockAction" TEXT,
  "doorName" VARCHAR(255),
  reason TEXT,
  "faceEmbedding" BYTEA,
  "faceEmbeddingDims" INTEGER,
  "faceEmbeddingModelTag" VARCHAR(128),
  "faceEmbeddingQuality" REAL,
  "capturedAt" VARCHAR(64),        -- ISO-8601 UTC capture time of the decided frame
  "trackId" VARCHAR(64),           -- tracker id of the passage (one person, one event)
  "recordingChannel" VARCHAR(16),  -- NVR channel the gate was recorded on
  "gateId" VARCHAR(32)             -- gate id (N gates); NULL on rows from before gate ids: readers derive entry/exit from type
);
-- Gate filter of the history (the id, and the NULL legacy rows of entry/exit) in history order.
CREATE INDEX IF NOT EXISTS idx_access_logs_gate_ts ON access_logs ("gateId", "timestamp" DESC, id DESC);

CREATE TABLE IF NOT EXISTS smart_lock_state (
  "lockId" VARCHAR(64) PRIMARY KEY,
  "doorName" VARCHAR(255),
  state VARCHAR(32),
  "isLocked" BOOLEAN,
  "batteryLevel" INTEGER,
  "signalDbm" INTEGER,
  "firmwareVersion" VARCHAR(64),
  "lastActionAt" VARCHAR(64),
  "lastActionBy" VARCHAR(255),
  "autoRelockSeconds" INTEGER,
  status VARCHAR(32)
);

-- Lock state per door (N gates; each gate opens its own door). The legacy
-- single-row smart_lock_state above IS door "main" and is written together
-- with its row here. Same DDL as PG_DOOR_LOCK_STATES_DDL in src/server/db.ts.
CREATE TABLE IF NOT EXISTS door_lock_states (
  "doorId" VARCHAR(32) PRIMARY KEY CONSTRAINT door_lock_states_door_id_check CHECK ("doorId" ~ '^[a-z][a-z0-9-]{1,31}$'),
  state JSONB NOT NULL,            -- SmartLockState of the door (known fields only, no credentials)
  "updatedAt" VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_config (
  id VARCHAR(64) PRIMARY KEY,
  enabled BOOLEAN,
  url TEXT,
  "gateInTitle" VARCHAR(255),
  "gateOutTitle" VARCHAR(255),
  "includeEmployeeCode" BOOLEAN
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id VARCHAR(64) PRIMARY KEY,
  timestamp VARCHAR(64) NOT NULL,
  url TEXT,
  method VARCHAR(16),
  payload TEXT,
  "statusCode" INTEGER,
  "statusText" VARCHAR(128),
  "responseBody" TEXT,
  success BOOLEAN,
  error TEXT,
  "scanType" VARCHAR(16),
  "userName" VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS mobile_notifications (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  timestamp VARCHAR(64) NOT NULL,
  type VARCHAR(32),
  read BOOLEAN DEFAULT FALSE,
  "employeeId" VARCHAR(64),
  "employeeName" VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS camera_streams_config (
  id VARCHAR(64) PRIMARY KEY,
  data JSONB NOT NULL,
  "updatedAt" VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS door_controller_config (
  id VARCHAR(64) PRIMARY KEY,
  data JSONB NOT NULL,
  "updatedAt" VARCHAR(64)
);


CREATE TABLE IF NOT EXISTS resolved_stranger_clusters (
  "clusterId" VARCHAR(128) PRIMARY KEY,
  "resolvedAt" VARCHAR(64),
  "resolvedBy" VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS stranger_resolutions (
  id VARCHAR(128) PRIMARY KEY,
  "clusterId" VARCHAR(128) UNIQUE NOT NULL,
  action VARCHAR(32) NOT NULL,
  "employeeId" VARCHAR(64),
  actor VARCHAR(255) NOT NULL,
  "resolvedAt" VARCHAR(64) NOT NULL,
  "logIds" JSONB NOT NULL,
  "sourceLogId" VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb  -- stranger_faces ids covered (sorted)
);

CREATE TABLE IF NOT EXISTS stranger_resolution_events (
  id VARCHAR(128) PRIMARY KEY,
  "clusterId" VARCHAR(128) NOT NULL,
  action VARCHAR(32) NOT NULL,
  "employeeId" VARCHAR(64),
  actor VARCHAR(255) NOT NULL,
  "resolvedAt" VARCHAR(64) NOT NULL,
  "logIds" JSONB NOT NULL,
  "sourceLogId" VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb  -- stranger_faces ids covered (sorted)
);
CREATE INDEX IF NOT EXISTS idx_stranger_resolution_events_cluster
  ON stranger_resolution_events ("clusterId", "resolvedAt");

-- One row per unrecognised face of an access event (per-face stranger records).
-- Biometric: crop (JPEG) and embedding are cleared by the retention purge,
-- which sets "purgedAt" and keeps the row as an audit tombstone. Same DDL as
-- PG_STRANGER_FACES_DDL in src/server/db.ts.
CREATE TABLE IF NOT EXISTS stranger_faces (
  id VARCHAR(64) COLLATE "C" PRIMARY KEY,
  "logId" VARCHAR(64) NOT NULL REFERENCES access_logs (id) ON DELETE CASCADE,
  "faceIndex" INTEGER NOT NULL,
  "capturedAt" VARCHAR(64) COLLATE "C" NOT NULL,
  gate VARCHAR(16) NOT NULL,
  "streamId" VARCHAR(64),
  engine VARCHAR(16) NOT NULL,     -- legacy | pipeline
  "trackId" VARCHAR(64),
  box JSONB NOT NULL,              -- [x1, y1, x2, y2] in source pixels
  "sourceWidth" INTEGER,
  "sourceHeight" INTEGER,
  "detectorScore" REAL NOT NULL,
  quality REAL NOT NULL,
  "edgeEnergy" REAL,
  "sizePx" INTEGER NOT NULL,
  embedding BYTEA,                 -- float32 little-endian, like access_logs."faceEmbedding"
  dims INTEGER,
  "modelTag" VARCHAR(128),
  crop BYTEA,                      -- JPEG face crop
  "createdAt" VARCHAR(64) NOT NULL,
  "purgedAt" VARCHAR(64),
  -- Recognised-face observation (accuracy wave): set when the door engine
  -- granted this face. Such rows are not strangers (grouping skips them) but
  -- feed camera adaptation. NULL on every stranger face.
  "employeeId" VARCHAR(64),
  "matchCosine" REAL,
  "matchMargin" REAL,
  "gateId" VARCHAR(32)             -- gate id (N gates); NULL on older faces: readers derive it from gate
);
CREATE INDEX IF NOT EXISTS idx_stranger_faces_captured ON stranger_faces ("capturedAt" DESC, id DESC)
  WHERE "purgedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stranger_faces_log ON stranger_faces ("logId", "faceIndex");
CREATE INDEX IF NOT EXISTS idx_stranger_faces_recognised ON stranger_faces ("employeeId", "capturedAt" DESC, id DESC)
  WHERE "employeeId" IS NOT NULL AND "purgedAt" IS NULL;

-- One row per shadow-engine outcome next to the nearest door-engine event
-- (src/server/shadowResults.ts). No images, no embeddings; retention is a
-- DELETE by "decidedAt" (SHADOW_RESULT_RETENTION_DAYS, owner: 30 days). No
-- foreign key to access_logs on purpose: the event may not be durable yet when
-- the shadow decides, and clearing the history must not erase the comparison.
-- Same DDL as PG_SHADOW_RESULTS_DDL in src/server/db.ts.
CREATE TABLE IF NOT EXISTS pipeline_shadow_results (
  id VARCHAR(64) COLLATE "C" PRIMARY KEY,
  gate VARCHAR(64) NOT NULL,             -- gate id; rows from before gate ids say ENTRY/EXIT (read as entry/exit)
  "trackId" VARCHAR(64) NOT NULL,
  outcome VARCHAR(16) NOT NULL,          -- employee | stranger | insufficient
  "employeeId" VARCHAR(64),
  "fusedCosine" REAL,
  margin REAL,
  "runnerUpEmployeeId" VARCHAR(64),
  "runnerUpCosine" REAL,
  basis VARCHAR(128) NOT NULL,
  "fusionBasis" VARCHAR(128),
  "meanCheckRefused" BOOLEAN,
  "framesSeen" INTEGER NOT NULL,
  "framesUsed" INTEGER NOT NULL,
  "firstSeenAt" VARCHAR(64) NOT NULL,
  "firstUsableAt" VARCHAR(64),
  "decidedAt" VARCHAR(64) COLLATE "C" NOT NULL,
  "legacyLogId" VARCHAR(64),             -- nearest door-engine event on the gate, if any
  "legacyStatus" VARCHAR(16),            -- GRANTED | DENIED
  "legacyEmployeeId" VARCHAR(64),
  agreement VARCHAR(32) NOT NULL,        -- agree | shadow-only | legacy-only | identity-mismatch | none
  "createdAt" VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_results_decided ON pipeline_shadow_results ("decidedAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_results_gate ON pipeline_shadow_results (gate, "decidedAt" DESC);

-- AI recognition engine settings (engine mode, Gemini model, thresholds).
-- Single row id = 'default'; the server hydrates it into memory at startup.
-- Managed departments and positions, as one document.
CREATE TABLE IF NOT EXISTS org_catalog (
  id VARCHAR(64) PRIMARY KEY,
  data JSONB NOT NULL,
  "updatedAt" VARCHAR(64)
);

-- Operator accounts. `data` holds the full record including the scrypt
-- password hash, which the API never returns.
CREATE TABLE IF NOT EXISTS app_users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  data JSONB NOT NULL,
  "updatedAt" VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS ai_recognition_config (
  id VARCHAR(64) PRIMARY KEY,
  config_json JSONB NOT NULL,
  "updatedAt" VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS face_templates (
  id VARCHAR(64) PRIMARY KEY,
  "employeeId" VARCHAR(64) NOT NULL,
  embedding BYTEA NOT NULL,        -- float32 little-endian, `dims` values, L2-normalised
  dims INTEGER NOT NULL,
  "modelTag" VARCHAR(64) NOT NULL, -- e.g. arcface_w600k_r50; never compare across tags
  source VARCHAR(32) NOT NULL,     -- enrollment | merge | manual | auto | adaptation
  quality REAL,
  "capturedAt" VARCHAR(64),
  "sourceLogId" VARCHAR(64),
  "streamId" VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_face_templates_emp ON face_templates ("employeeId");

-- Indices for rapid query performance
CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON mobile_notifications (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_timestamp ON webhook_logs (timestamp DESC);
