// Each account gets a fresh process: Amplify's current-user state is never shared.
if (require.main === module) process.once('disconnect', () => process.exit(1));
async function signInAccount(account, cognito, dependencies = {}) {
    const { Amplify } = dependencies.amplify || require('aws-amplify');
    const { signIn, fetchAuthSession } = dependencies.auth || require('aws-amplify/auth');
    const { cognitoUserPoolsTokenProvider } = dependencies.cognito || require('aws-amplify/auth/cognito');
    const values = new Map();
    cognitoUserPoolsTokenProvider.setKeyValueStorage({
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { values.set(key, value); },
      async removeItem(key) { values.delete(key); },
      async clear() { values.clear(); },
    });
    Amplify.configure({ Auth: { Cognito: cognito } });
    const result = await signIn({ ...account, options: { authFlowType: 'USER_SRP_AUTH' } });
    if (!result.isSignedIn) {
      throw new Error('additional_authentication_challenge');
    }
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString();
    if (!idToken) throw new Error();
    return idToken;
}
if (require.main === module) process.once('message', async ({ account, cognito }) => {
  try {
    const idToken = await signInAccount(account, cognito);
    process.send({ idToken }, () => process.exit(0));
  } catch (error) {
    process.send({ error: error.message === 'additional_authentication_challenge' ? error.message : 'cognito_sign_in_failed' }, () => process.exit(1));
  }
});
module.exports = { signInAccount };
