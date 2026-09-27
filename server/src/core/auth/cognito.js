import "dotenv/config";
import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifier;

function getVerifier() {
  if (!verifier) {
    const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_USER_POOL_CLIENT_ID: clientId } = process.env;
    if (!userPoolId || !clientId) throw new Error("COGNITO_USER_POOL_ID and COGNITO_USER_POOL_CLIENT_ID are required.");
    verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
  }
  return verifier;
}

export async function verifyIdToken(token) {
  const claims = await getVerifier().verify(token);
  if (!claims.sub || !claims.email) throw new Error("Cognito token is missing the required user claims.");
  return { cognitoSub: claims.sub, email: claims.email.toLowerCase() };
}
