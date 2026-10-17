// Every error the API returns has the same shape:
//   { "error": { "code": "VERSION_CONFLICT", "message": "...", ...details } }
// Route code just throws one of these classes; the central error handler in
// app.ts turns it into the HTTP response.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 400: the request body or parameters are malformed. */
export class ValidationError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

/** 401: not logged in, or the session has expired. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'You need to log in.') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

/** 403: logged in and allowed to see this thing, but not allowed to do this action. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this.') {
    super(403, 'FORBIDDEN', message);
  }
}

/**
 * 404: does not exist, OR exists in a team the user does not belong to.
 * Both cases return the same response, so outsiders cannot discover what exists.
 */
export class NotFoundError extends AppError {
  constructor(what = 'Item') {
    super(404, 'NOT_FOUND', `${what} not found.`);
  }
}

/** 409: the request conflicts with the current state (stale version, already claimed). */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(409, code, message, details);
  }
}

/** 422: well-formed, but breaks a business rule (invalid workflow transition, etc.). */
export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(422, code, message, details);
  }
}
