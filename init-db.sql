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
  reason TEXT
);

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

-- Indices for rapid query performance
CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON mobile_notifications (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_timestamp ON webhook_logs (timestamp DESC);
