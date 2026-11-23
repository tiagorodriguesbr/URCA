import { deleteApp, getApps, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  updateProfile,
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);

function createFirestoreInstance(): Firestore {
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createFirestoreInstance();
export const auth = getAuth(app);
export const functions = getFunctions(app, 'southamerica-east1');

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function getFirestoreErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const info = JSON.parse(message) as Partial<FirestoreErrorInfo>;
    if (typeof info.error === 'string') {
      const ctx = info.path ? ` (${info.operationType}: ${info.path})` : '';
      if (info.error.toLowerCase().includes('permission')) {
        return `Permissão insuficiente no Firestore${ctx}. Verifique se as regras do Firestore (firestore.rules) estão implantadas e se seu perfil está ativo com permissão de edição.`;
      }
      return `${info.error}${ctx}`;
    }
  } catch {
    if (message.toLowerCase().includes('permission')) {
      return `Permissão insuficiente no Firestore: ${message}`;
    }
    return message;
  }
  return message;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

/**
 * Provisions a new Firebase Auth user (Email + Password) using an isolated
 * secondary Firebase App instance so the active Master Admin session stays signed in.
 */
export async function provisionAuthUserViaSecondaryApp(
  email: string,
  password: string,
  displayName: string,
  createProfile: (uid: string) => Promise<void>
): Promise<string> {
  const secondaryName = `CrepsUrcaUserProvisioner_${Date.now()}`;
  const secondaryApp = initializeApp(firebaseConfig, secondaryName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    try {
      await updateProfile(cred.user, { displayName });
      await createProfile(cred.user.uid);
    } catch (error) {
      try {
        await deleteUser(cred.user);
      } catch (cleanupError) {
        console.error('Failed to remove Auth user after profile creation failed', cleanupError);
        throw new Error(
          `O cadastro do perfil falhou e não foi possível remover a conta Auth ${cred.user.uid}.`
        );
      }
      throw error;
    }

    try {
      await sendEmailVerification(cred.user);
    } catch (error) {
      console.error('Failed to send verification email for new user', error);
    }
    return cred.user.uid;
  } finally {
    try {
      await signOut(secondaryAuth);
    } catch (error) {
      console.error('Failed to sign out secondary Firebase Auth app', error);
    }
    try {
      await deleteApp(secondaryApp);
    } catch (error) {
      console.error('Failed to dispose secondary Firebase App', error);
    }
  }
}

export async function sendUserPasswordResetEmail(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Informe um e-mail válido para enviar a redefinição de senha.');
  }
  await sendPasswordResetEmail(auth, cleanEmail);
}

export async function adminUpdateUserCredentialsViaFunction(input: {
  targetUid: string;
  email?: string;
  password?: string;
}): Promise<{ ok: boolean; emailUpdated: boolean; passwordUpdated: boolean }> {
  const callable = httpsCallable<
    { targetUid: string; email?: string; password?: string },
    { ok: boolean; emailUpdated: boolean; passwordUpdated: boolean }
  >(functions, 'adminUpdateUserCredentials');

  try {
    const res = await callable(input);
    return res.data;
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code || '';
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    if (
      code === 'functions/not-found' ||
      code === 'functions/unavailable' ||
      code === 'functions/internal' && (lower.includes('internal') || lower.includes('failed to fetch') || lower.includes('cors')) ||
      lower.includes('failed to fetch') ||
      lower.includes('cors') ||
      lower.includes('network')
    ) {
      throw new Error(
        'A alteração direta de e-mail/senha de outro usuário requer a Cloud Function "adminUpdateUserCredentials" implantada no Firebase (plano Blaze). Rode "firebase deploy --only functions" ou use "Enviar link de redefinição de senha por e-mail".'
      );
    }

    throw new Error(message || 'Não foi possível atualizar e-mail/senha do usuário.');
  }
}
