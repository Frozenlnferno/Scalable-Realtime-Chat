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

export const login = (email, password) => signIn({
  username: email,
  password,
});

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
