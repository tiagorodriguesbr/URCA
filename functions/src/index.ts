import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

initializeApp();

const db = getFirestore('ai-studio-d66f2262-5512-45ba-9cb9-7318c7b14bc5');
const adminAuth = getAuth();

const BOOTSTRAPPED_ADMIN_EMAIL = 'tiago.rodrigues2933@gmail.com';
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function diffKeys(beforeData: Record<string, unknown> | undefined, afterData: Record<string, unknown> | undefined): string[] {
  const keys = new Set([
    ...Object.keys(beforeData ?? {}),
    ...Object.keys(afterData ?? {}),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === 'updatedAt' || key === 'createdAt') continue;
    if (JSON.stringify(beforeData?.[key]) !== JSON.stringify(afterData?.[key])) {
      changed.push(key);
    }
  }
  return changed.slice(0, 20);
}

export const auditTaskWrites = onDocumentWritten(
  {
    document: 'tasks/{taskId}',
    database: 'ai-studio-d66f2262-5512-45ba-9cb9-7318c7b14bc5',
    region: 'southamerica-east1',
  },
  async (event) => {
    const beforeData = event.data?.before.data() as Record<string, unknown> | undefined;
    const afterData = event.data?.after.data() as Record<string, unknown> | undefined;
    const action = !beforeData ? 'create' : !afterData ? 'delete' : 'update';
    const title = String(afterData?.title ?? beforeData?.title ?? event.params.taskId);

    await db.collection('audit_logs').add({
      workspaceId: 'creps-urca',
      entityType: 'task',
      entityId: event.params.taskId,
      action,
      summary: `[Cloud Function] Tarefa "${title}" (${action})`,
      actorUid: String(afterData?.createdByUid ?? beforeData?.createdByUid ?? 'system'),
      actorEmail: 'cloud-function@creps-urca.internal',
      actorName: String(afterData?.createdByName ?? beforeData?.createdByName ?? 'Cloud Functions'),
      changedFields: diffKeys(beforeData, afterData),
      amount: 0,
      source: 'cloud_function_trigger',
      timestamp: FieldValue.serverTimestamp(),
    });
  }
);

export const auditPaymentWrites = onDocumentWritten(
  {
    document: 'payments/{paymentId}',
    database: 'ai-studio-d66f2262-5512-45ba-9cb9-7318c7b14bc5',
    region: 'southamerica-east1',
  },
  async (event) => {
    const beforeData = event.data?.before.data() as Record<string, unknown> | undefined;
    const afterData = event.data?.after.data() as Record<string, unknown> | undefined;
    const action = !beforeData ? 'create' : !afterData ? 'delete' : 'update';
    const description = String(afterData?.description ?? beforeData?.description ?? event.params.paymentId);
    const amount = Number(afterData?.amount ?? beforeData?.amount ?? 0);

    await db.collection('audit_logs').add({
      workspaceId: 'creps-urca',
      entityType: 'payment',
      entityId: event.params.paymentId,
      action,
      summary: `[Cloud Function] Pagamento "${description}" - R$ ${amount.toFixed(2)} (${action})`,
      actorUid: String(afterData?.createdByUid ?? beforeData?.createdByUid ?? 'system'),
      actorEmail: 'cloud-function@creps-urca.internal',
      actorName: String(afterData?.createdByName ?? beforeData?.createdByName ?? 'Cloud Functions'),
      changedFields: diffKeys(beforeData, afterData),
      amount,
      source: 'cloud_function_trigger',
      timestamp: FieldValue.serverTimestamp(),
    });
  }
);

export const adminUpdateUserCredentials = onCall(
  {
    region: 'southamerica-east1',
    cors: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
    }

    const callerUid = request.auth.uid;
    const tokenEmail =
      typeof request.auth.token.email === 'string'
        ? request.auth.token.email.trim().toLowerCase()
        : '';
    const isBootstrappedAdmin =
      tokenEmail === BOOTSTRAPPED_ADMIN_EMAIL && request.auth.token.email_verified === true;

    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerData = callerSnap.exists
      ? (callerSnap.data() as {
          active?: boolean;
          role?: string;
          displayName?: string;
          email?: string;
        })
      : undefined;

    const isProfileAdmin = Boolean(
      callerData &&
        callerData.active === true &&
        ['socio', 'diretor', 'master'].includes(String(callerData.role || ''))
    );

    if (!isBootstrappedAdmin && !isProfileAdmin) {
      throw new HttpsError(
        'permission-denied',
        'Apenas Sócios ou Diretores ativos podem alterar e-mail e senha de usuários.'
      );
    }

    const payload = (request.data ?? {}) as {
      targetUid?: unknown;
      email?: unknown;
      password?: unknown;
    };

    const targetUid = typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
    if (!VALID_ID_REGEX.test(targetUid)) {
      throw new HttpsError('invalid-argument', 'Identificador do usuário inválido.');
    }

    const rawEmail =
      typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const rawPassword = typeof payload.password === 'string' ? payload.password : '';

    if (!rawEmail && !rawPassword) {
      throw new HttpsError('invalid-argument', 'Informe um novo e-mail ou uma nova senha.');
    }

    if (rawEmail) {
      if (rawEmail.length < 5 || rawEmail.length > 150 || !EMAIL_REGEX.test(rawEmail)) {
        throw new HttpsError('invalid-argument', 'Informe um e-mail válido.');
      }
    }

    if (rawPassword) {
      if (rawPassword.length < 6 || rawPassword.length > 128) {
        throw new HttpsError(
          'invalid-argument',
          'A nova senha deve ter entre 6 e 128 caracteres.'
        );
      }
    }

    let targetAuthUser;
    try {
      targetAuthUser = await adminAuth.getUser(targetUid);
    } catch {
      throw new HttpsError(
        'not-found',
        'Conta não encontrada no Firebase Authentication.'
      );
    }

    const currentAuthEmail = (targetAuthUser.email || '').trim().toLowerCase();
    const emailChanged = Boolean(rawEmail && rawEmail !== currentAuthEmail);
    const passwordChanged = Boolean(rawPassword);

    if (!emailChanged && !passwordChanged) {
      return { ok: true, emailUpdated: false, passwordUpdated: false };
    }

    const authUpdate: {
      email?: string;
      emailVerified?: boolean;
      password?: string;
    } = {};

    if (emailChanged) {
      authUpdate.email = rawEmail;
      authUpdate.emailVerified = true;
    }
    if (passwordChanged) {
      authUpdate.password = rawPassword;
    }

    try {
      await adminAuth.updateUser(targetUid, authUpdate);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code || '';
      if (code === 'auth/email-already-exists') {
        throw new HttpsError(
          'already-exists',
          'Este e-mail já está em uso por outra conta no Firebase Authentication.'
        );
      }
      if (code === 'auth/invalid-email') {
        throw new HttpsError('invalid-argument', 'O e-mail informado é inválido.');
      }
      if (code === 'auth/invalid-password' || code === 'auth/weak-password') {
        throw new HttpsError(
          'invalid-argument',
          'A senha informada é muito fraca. Utilize pelo menos 6 caracteres.'
        );
      }
      throw new HttpsError(
        'internal',
        error instanceof Error ? error.message : 'Falha ao atualizar credenciais no Auth.'
      );
    }

    const targetUserRef = db.collection('users').doc(targetUid);
    const targetUserSnap = await targetUserRef.get();
    const targetDisplayName = String(
      (targetUserSnap.data()?.displayName as string | undefined) ||
        targetAuthUser.displayName ||
        targetUid
    ).slice(0, 80);

    if (emailChanged && targetUserSnap.exists) {
      await targetUserRef.update({
        email: rawEmail,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const changedFields: string[] = [];
    if (emailChanged) changedFields.push('email');
    if (passwordChanged) changedFields.push('password');

    const actorName = String(
      callerData?.displayName ||
        (typeof request.auth.token.name === 'string' ? request.auth.token.name : '') ||
        'Administrador'
    ).slice(0, 80);
    const actorEmail = String(callerData?.email || tokenEmail || 'admin@crepsurca.com').slice(
      0,
      150
    );

    const changeParts: string[] = [];
    if (emailChanged) changeParts.push(`e-mail para ${rawEmail}`);
    if (passwordChanged) changeParts.push('senha redefinida');

    const summary = `Credenciais de ${targetDisplayName} atualizadas (${changeParts.join(' e ')}) por ${actorName}`.slice(
      0,
      300
    );

    await db.collection('audit_logs').add({
      workspaceId: 'creps-urca',
      entityType: 'user',
      entityId: targetUid,
      action: 'update',
      summary,
      actorUid: callerUid,
      actorEmail,
      actorName,
      changedFields,
      amount: 0,
      source: 'cloud_function_trigger',
      timestamp: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      emailUpdated: emailChanged,
      passwordUpdated: passwordChanged,
    };
  }
);
