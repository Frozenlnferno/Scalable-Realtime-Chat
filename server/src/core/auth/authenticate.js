import { verifyIdToken } from "./cognito.js";
import { upsertUser } from "../../features/users/user.service.js";

function unauthorized(message = "A valid Cognito ID token is required.") {
  const error = new Error(message);
  error.status = 401;
  return error;
}

export function createAuthenticator(verify = verifyIdToken, sync = upsertUser) {
  return async (token) => {
    let claims;
    try {
      claims = await verify(token);
    } catch {
      throw unauthorized();
    }
    return sync(claims);
  };
}

export const getAuthenticatedUser = createAuthenticator();

export async function authenticateRequest(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return next(unauthorized());
  try {
    req.user = await getAuthenticatedUser(token);
    next();
  } catch (error) {
    next(error);
  }
}
