-- 0005: Better Auth tables (organization plugin), hand-authored to match the Drizzle schema in
-- src/auth/schema.ts. Quoted identifiers keep Better Auth's default camelCase column names.
--
-- Link to tenants: organization.id IS the tenant id. The auth config's afterCreateOrganization hook
-- inserts tenants(id = organization.id) and mirrors every auth member into the app-level `members`
-- table (members.user_id -> "user".id) with the same owner/manager/staff role.
--
-- RLS Ruling: these tables are NOT row-level-secured. Better Auth must look rows up before any tenant is
-- known (sign-in by email, session by token), so a tenant predicate cannot apply to them. Instead the
-- app role e2p_app and the Data API roles hold no privilege on them at all (the default-privilege
-- revoke from 0004 covers tables created here; asserted in src/auth/auth.test.ts). Only the auth
-- library, connected as the owner role, touches them. Tenant data stays in the RLS-protected tables.

CREATE TABLE "user" (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  email           text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image           text,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id                     text PRIMARY KEY,
  "expiresAt"            timestamptz NOT NULL,
  token                  text NOT NULL UNIQUE,
  "createdAt"            timestamptz NOT NULL DEFAULT now(),
  "updatedAt"            timestamptz NOT NULL DEFAULT now(),
  "ipAddress"            text,
  "userAgent"            text,
  "userId"               text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  "activeOrganizationId" text
);

CREATE TABLE account (
  id                       text PRIMARY KEY,
  "accountId"              text NOT NULL,
  "providerId"             text NOT NULL,
  "userId"                 text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  scope                    text,
  password                 text,
  "createdAt"              timestamptz NOT NULL DEFAULT now(),
  "updatedAt"              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification (
  id           text PRIMARY KEY,
  identifier   text NOT NULL,
  value        text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization (
  id          text PRIMARY KEY,           -- == tenants.id
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  logo        text,
  metadata    text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member (
  id               text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  "userId"         text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role             text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','manager','staff')),
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "userId")
);

CREATE TABLE invitation (
  id               text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  email            text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner','manager','staff')),
  status           text NOT NULL DEFAULT 'pending',
  "expiresAt"      timestamptz,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "inviterId"      text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE INDEX member_org_idx ON member ("organizationId");
CREATE INDEX session_user_idx ON session ("userId");
