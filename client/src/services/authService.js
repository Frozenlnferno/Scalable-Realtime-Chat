import { confirmSignUp, fetchAuthSession, getCurrentUser, signIn, signOut, signUp } from 'aws-amplify/auth';

export const register = (email, password) => signUp({
  username: email,
  password,
  options: { userAttributes: { email } },
});

export const confirmRegistration = (email, code) => confirmSignUp({
  username: email,
  confirmationCode: code,
});

export async function login(email, password) {
  const result = await signIn({ username: email, password });
  if (!result.isSignedIn) {
    const step = result.nextStep?.signInStep;
    throw new Error(step
      ? `Your account needs another verification step (${step}) before it can open the dashboard.`
      : 'Sign-in did not complete. Please try again.');
  }
  return result;
}

export async function getAuthenticatedSession() {
  const [user, session] = await Promise.all([getCurrentUser(), fetchAuthSession()]);
  const idToken = session.tokens?.idToken;
  if (!idToken) throw new Error('Your session has expired. Please sign in again.');
  return { cognitoSub: user.userId, email: idToken.payload.email, idToken: idToken.toString() };
}

export const logout = () => signOut();

export function getAuthErrorMessage(error) {
  const messages = {
    UsernameExistsException: 'An account with this email already exists.',
    UserNotFoundException: 'No account was found with that email.',
    NotAuthorizedException: 'The email or password is incorrect.',
    CodeMismatchException: 'That confirmation code is incorrect.',
    ExpiredCodeException: 'That confirmation code has expired. Please sign up again.',
  };

  return messages[error?.name] || error?.message || 'Something went wrong. Please try again.';
}
