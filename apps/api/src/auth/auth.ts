// Sign-in, the current-user profile and password changes are handled by the separate
// FastAPI auth service (apps/auth). This API only verifies the tokens it issues
// (shared JWT_SECRET, see common/auth.guard.ts).
//
// Admin actions in this API (create user, reset password) still need to hash passwords,
// in the same bcrypt format the auth service verifies.
import * as bcrypt from 'bcryptjs';

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
