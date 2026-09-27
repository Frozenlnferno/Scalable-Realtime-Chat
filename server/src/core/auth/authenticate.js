import { verifyIdToken } from "./cognito.js";
import { upsertUser } from "../../features/users/user.service.js";

function unauthorized(message = "A valid Cognito ID token is required.") {
  const error = new Error(message);
  error.status = 401;
  return error;
}

export async function getAuthenticatedUser(token) {
  try {
    const claims = await verifyIdToken(token);
    return await upsertUser(claims);
  } catch (error) {
    if (error.status) throw error;
    throw unauthorized();
  }
}

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
