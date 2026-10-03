#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Firestore } from '@google-cloud/firestore';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';

const execFileAsync = promisify(execFile);

const ACCESS_CONFIG = {
  'internal-test': {
    serviceValue: 'internal_test',
    label: 'Internal Test Access',
    commercialQuotaBypass: true,
  },
  'sandbox-commerce': {
    serviceValue: 'sandbox_commerce',
    label: 'Sandbox Commerce Access',
    commercialQuotaBypass: false,
  },
};
const MAX_HOURS = { sandbox: 31 * 24, production: 7 * 24 };
const SAFE_PROJECT = /^[a-z][a-z0-9-]{4,29}$/;
const SAFE_REASON = /^[A-Z0-9_]{3,40}$/;
const SAFE_TICKET = /^[A-Za-z0-9._-]{3,80}$/;
const SAFE_ACCESS_TOKEN = /^[A-Za-z0-9._~-]{20,4096}$/;

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const usage = () => {
  process.stdout.write([
    'Usage:',
    '  npm run internal-test:access -- grant --project <firebase-project> --uid <exact-uid> --environment <sandbox|production> --access-type <internal-test|sandbox-commerce> --duration-hours <n> --reason <CODE> --ticket <ID> --actor-uid <staff-uid> [--credential-source <adc|gcloud>] [--confirm-production <firebase-project>] [--check-credentials] [--apply]',
    '  npm run internal-test:access -- revoke --project <firebase-project> --uid <exact-uid> --environment <sandbox|production> --access-type <internal-test|sandbox-commerce> --reason <CODE> --ticket <ID> --actor-uid <staff-uid> [--credential-source <adc|gcloud>] [--confirm-production <firebase-project>] [--check-credentials] [--apply]',
    '  Add --bootstrap-admin --confirm-admin-bootstrap <firebase-project> only when the project owner is bootstrapping their own exact Firebase UID through gcloud.',
    '  Owner/admin self-access changes are rejected by the remote callable and must use this audited local command.',
    '',
    'Without --apply, the command is a read-only dry run.',
    'The same --ticket may be retried only with identical request details.',
  ].join('\n') + '\n');
};

const parseArgs = (argv) => {
  const command = argv[0];
  const values = {};
  const booleans = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'apply' || key === 'check-credentials' || key === 'bootstrap-admin') {
      booleans.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return {
    command,
    values,
    apply: booleans.has('apply'),
    checkCredentials: booleans.has('check-credentials'),
    bootstrapAdmin: booleans.has('bootstrap-admin'),
  };
};

const required = (values, key) => {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
};

const validateUid = (value, label) => {
  if (value.length > 128 || value.includes('/') || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} is not a safe Firebase UID.`);
  }
  return value;
};

const accountDocumentId = (environment, uid) => {
  const digest = createHash('sha256')
    .update(['monetization-account-v1', uid].join('\u001f'), 'utf8')
    .digest('hex')
    .slice(0, 48);
  return `${environment}_${digest}`;
};

const gcloudAccessTokenProvider = (project) => {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAtMs > Date.now() + 5 * 60 * 1_000) return cached.token;
    let stdout;
    try {
      ({ stdout } = await execFileAsync('gcloud', [
        'auth',
        'print-access-token',
        `--project=${project}`,
      ], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024,
        windowsHide: true,
      }));
    } catch {
      throw new Error('gcloud could not provide an access token. Run gcloud auth login and retry.');
    }
    const token = stdout.trim();
    if (!SAFE_ACCESS_TOKEN.test(token)) {
      throw new Error('gcloud returned a malformed access token.');
    }
    cached = { token, expiresAtMs: Date.now() + 30 * 60 * 1_000 };
    return token;
  };
};

async function createAdminClients(project, credentialSource) {
  if (credentialSource === 'adc') {
    const app = initializeApp({
      credential: applicationDefault(),
      projectId: project,
    }, `test-access-${Date.now()}`);
    return { auth: getAuth(app), db: getFirestore(app) };
  }

  const tokenProvider = gcloudAccessTokenProvider(project);
  const token = await tokenProvider();
  process.env.GOOGLE_CLOUD_QUOTA_PROJECT = project;
  const app = initializeApp({
    credential: {
      async getAccessToken() {
        return { access_token: await tokenProvider(), expires_in: 30 * 60 };
      },
    },
    projectId: project,
  }, `test-access-gcloud-${Date.now()}`);

  const oauthClient = new OAuth2Client({ eagerRefreshThresholdMillis: 5 * 60 * 1_000 });
  oauthClient.quotaProjectId = project;
  oauthClient.refreshHandler = async () => ({
    access_token: await tokenProvider(),
    expiry_date: Date.now() + 30 * 60 * 1_000,
  });
  oauthClient.setCredentials({
    access_token: token,
    expiry_date: Date.now() + 30 * 60 * 1_000,
    token_type: 'Bearer',
  });
  const firestoreAuth = new GoogleAuth({
    projectId: project,
    authClient: oauthClient,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const db = new Firestore({
    projectId: project,
    preferRest: true,
    auth: firestoreAuth,
    customHeaders: { 'x-goog-user-project': project },
  });
  return { auth: getAuth(app), db };
}

async function gcloudText(args, failureMessage) {
  try {
    const { stdout } = await execFileAsync('gcloud', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    throw new Error(failureMessage);
  }
}

async function verifyAdminBootstrapEligibility({ auth, project, actorUid, targetUid }) {
  if (actorUid !== targetUid) {
    throw new Error('Admin bootstrap requires --actor-uid and --uid to be the same exact UID.');
  }
  const activeAccount = await gcloudText(
    ['config', 'get-value', 'account', '--quiet'],
    'Could not determine the active gcloud account.',
  );
  if (!activeAccount || !activeAccount.includes('@')) {
    throw new Error('The active gcloud account is missing or malformed.');
  }
  const user = await auth.getUser(actorUid);
  if (user.disabled) throw new Error('The bootstrap Firebase account is disabled.');
  if (!user.email || user.email.toLowerCase() !== activeAccount.toLowerCase()) {
    throw new Error('The active gcloud account does not match the exact Firebase user email.');
  }
  if (user.emailVerified !== true) {
    throw new Error('The bootstrap Firebase account email is not verified.');
  }
  const roles = await gcloudText([
    'projects',
    'get-iam-policy',
    project,
    '--flatten=bindings[].members',
    `--filter=bindings.members:user:${activeAccount}`,
    '--format=value(bindings.role)',
  ], 'Could not verify the active gcloud account project role.');
  if (!roles.split(/\r?\n/).includes('roles/owner')) {
    throw new Error('Admin bootstrap requires the active gcloud account to be a project owner.');
  }
  return { user, activeAccount };
}

async function bootstrapCurrentProjectOwner({ auth, db, project, actorUid, targetUid, ticketId }) {
  const { user, activeAccount } = await verifyAdminBootstrapEligibility({
    auth,
    project,
    actorUid,
    targetUid,
  });
  const claimAdded = user.customClaims?.admin !== true;
  if (claimAdded) {
    await auth.setCustomUserClaims(actorUid, { ...(user.customClaims ?? {}), admin: true });
    await auth.revokeRefreshTokens(actorUid);
  }
  const bootstrapId = createHash('sha256')
    .update(['monetization-admin-bootstrap-v1', project, actorUid].join('\u001f'), 'utf8')
    .digest('hex');
  const auditRef = db.collection('monetizationAdminAudit').doc(bootstrapId);
  await db.runTransaction(async (transaction) => {
    if ((await transaction.get(auditRef)).exists) return;
    transaction.create(auditRef, {
        schemaVersion: 1,
        action: 'admin_bootstrap_verified',
        actorUid,
        actorRole: 'project_owner',
        subjectUid: actorUid,
        environment: 'production',
        reasonCode: 'OWNER_ADMIN_BOOTSTRAP',
        ticketDigest: createHash('sha256')
          .update(['support-ticket-v1', ticketId].join('\u001f'), 'utf8')
          .digest('hex'),
        gcloudPrincipalDigest: createHash('sha256')
          .update(['gcloud-principal-v1', activeAccount.toLowerCase()].join('\u001f'), 'utf8')
          .digest('hex'),
        claimAdded,
        createdAt: FieldValue.serverTimestamp(),
      });
  });
  return claimAdded;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.command !== 'grant' && parsed.command !== 'revoke') {
      usage();
      throw new Error('The command must be grant or revoke.');
    }
    const project = required(parsed.values, 'project');
    if (!SAFE_PROJECT.test(project)) {
      throw new Error('--project is not a valid Firebase project ID.');
    }
    const uid = validateUid(required(parsed.values, 'uid'), '--uid');
    const actorUid = validateUid(required(parsed.values, 'actor-uid'), '--actor-uid');
    const environment = required(parsed.values, 'environment');
    if (environment !== 'sandbox' && environment !== 'production') {
      throw new Error('--environment must be sandbox or production.');
    }
    const accessType = parsed.values['access-type']?.trim() || 'internal-test';
    if (!(accessType in ACCESS_CONFIG)) {
      throw new Error('--access-type must be internal-test or sandbox-commerce.');
    }
    if (accessType === 'sandbox-commerce' && environment !== 'sandbox') {
      throw new Error('--access-type sandbox-commerce requires --environment sandbox.');
    }
    const reasonCode = required(parsed.values, 'reason').toUpperCase();
    if (!SAFE_REASON.test(reasonCode)) {
      throw new Error('--reason must contain 3 to 40 uppercase letters, digits, or underscores.');
    }
    const ticketId = required(parsed.values, 'ticket');
    if (!SAFE_TICKET.test(ticketId)) {
      throw new Error('--ticket must contain 3 to 80 letters, digits, periods, underscores, or hyphens.');
    }
    if (environment === 'production' && parsed.values['confirm-production'] !== project) {
      throw new Error(`Production access requires --confirm-production ${project}.`);
    }
    const credentialSource = parsed.values['credential-source']?.trim() || 'adc';
    if (credentialSource !== 'adc' && credentialSource !== 'gcloud') {
      throw new Error('--credential-source must be adc or gcloud.');
    }
    if (parsed.bootstrapAdmin) {
      if (credentialSource !== 'gcloud') {
        throw new Error('--bootstrap-admin requires --credential-source gcloud.');
      }
      if (parsed.values['confirm-admin-bootstrap'] !== project) {
        throw new Error(`Admin bootstrap requires --confirm-admin-bootstrap ${project}.`);
      }
      if (!parsed.apply && !parsed.checkCredentials) {
        throw new Error('--bootstrap-admin requires --apply or --check-credentials.');
      }
    } else if (parsed.values['confirm-admin-bootstrap'] !== undefined) {
      throw new Error('--confirm-admin-bootstrap is only valid with --bootstrap-admin.');
    }

    let durationHours = 0;
    if (parsed.command === 'grant') {
      durationHours = Number(required(parsed.values, 'duration-hours'));
      const maximumHours = accessType === 'sandbox-commerce'
        ? MAX_HOURS.sandbox
        : MAX_HOURS[environment];
      if (!Number.isSafeInteger(durationHours) || durationHours <= 0 || durationHours > maximumHours) {
        throw new Error(`--duration-hours must be a whole number from 1 to ${maximumHours} for ${environment}.`);
      }
    }

    const accountId = accountDocumentId(environment, uid);
    if (!parsed.apply && !parsed.checkCredentials) {
      process.stdout.write(JSON.stringify({
        dryRun: true,
        command: parsed.command,
        accessType,
        project,
        environment,
        accountDocumentId: accountId,
        durationHours: parsed.command === 'grant' ? durationHours : undefined,
        reasonCode,
        ticketId,
        actorUid,
        credentialSource,
        adminBootstrapRequested: false,
        providerSafetyBypass: false,
        commercialQuotaBypass: ACCESS_CONFIG[accessType].commercialQuotaBypass,
        nextStep: 'Review the exact target, then repeat with --apply.',
      }, null, 2) + '\n');
      return;
    }

    const { auth, db } = await createAdminClients(project, credentialSource);
    if (parsed.checkCredentials && !parsed.apply) {
      const [actor, target] = await Promise.all([
        auth.getUser(actorUid),
        auth.getUser(uid),
        db.collection('monetizationTestAccessControls').doc(
          createHash('sha256').update(['test-access-control-probe-v1', uid].join('\u001f'))
            .digest('hex'),
        ).get(),
      ]);
      let bootstrapEligible = false;
      if (actor.disabled) throw new Error('The actor account is disabled.');
      if (actor.customClaims?.admin !== true && parsed.bootstrapAdmin) {
        await verifyAdminBootstrapEligibility({ auth, project, actorUid, targetUid: uid });
        bootstrapEligible = true;
      } else if (actor.customClaims?.admin !== true) {
        throw new Error('The actor account is not a current enabled admin.');
      }
      if (target.disabled) throw new Error('The target account is disabled.');
      process.stdout.write(JSON.stringify({
        credentialCheck: true,
        credentialSource,
        project,
        actorAdmin: actor.customClaims?.admin === true,
        adminBootstrapEligible: bootstrapEligible,
        targetEnabled: true,
        firestoreReachable: true,
        mutationPerformed: false,
      }, null, 2) + '\n');
      return;
    }

    if (parsed.bootstrapAdmin) {
      const bootstrapped = await bootstrapCurrentProjectOwner({
        auth,
        db,
        project,
        actorUid,
        targetUid: uid,
        ticketId,
      });
      process.stdout.write(
        bootstrapped
          ? 'Bootstrapped the verified project owner as the ManaSplit admin.\n'
          : 'The verified project owner is already a ManaSplit admin.\n',
      );
    }

    const { setMonetizationTestAccessForTrustedLocalOperator } = await import('../lib/monetizationSupport.js');
    const config = ACCESS_CONFIG[accessType];
    const result = await setMonetizationTestAccessForTrustedLocalOperator({
      auth,
      db,
      actor: { uid: actorUid, role: 'admin' },
      targetUid: uid,
      environment,
      reasonCode,
      ticketId,
      action: parsed.command,
      accessType: config.serviceValue,
      ...(parsed.command === 'grant' ? { durationHours } : {}),
    });
    const expiry = typeof result.expiresAt === 'number'
      ? `; expires ${new Date(result.expiresAt).toISOString()}`
      : '';
    const duplicate = result.duplicate ? ' (idempotent retry)' : '';
    process.stdout.write(
      `${parsed.command === 'grant' ? 'Activated' : 'Revoked'} ${environment} ${config.label} in ${project}${expiry}${duplicate}. Refresh the user's Firebase ID token or sign in again.\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Internal Test Access command failed.');
  }
}

await main();
