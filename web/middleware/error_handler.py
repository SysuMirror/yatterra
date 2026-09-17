"""Unified JSON error handling for the API layer."""
import logging
import traceback
from flask import jsonify, request
from werkzeug.exceptions import HTTPException

_log = logging.getLogger("api.errors")


class ApiError(Exception):
    """Structured API error with code and message."""
    def __init__(self, code: str, message: str, status: int = 400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details

    def to_dict(self):
        d = {"code": self.code, "message": self.message}
        if self.details:
            d["details"] = self.details
        return d


# Common error shortcuts
def not_found(message="Resource not found", details=None):
    return ApiError("NOT_FOUND", message, 404, details)

def forbidden(message="Permission denied", details=None):
    return ApiError("FORBIDDEN", message, 403, details)

def bad_request(message="Bad request", details=None):
    return ApiError("BAD_REQUEST", message, 400, details)

def unauthorized(message="Authentication required", details=None):
    return ApiError("UNAUTHORIZED", message, 401, details)

def conflict(message="Conflict", details=None):
    return ApiError("CONFLICT", message, 409, details)

def internal_error(message="Internal server error", details=None):
    return ApiError("INTERNAL_ERROR", message, 500, details)


def register_error_handlers(app):
    """Register unified JSON error handlers on the Flask app."""

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({"error": err.to_dict()}), err.status

    @app.errorhandler(HTTPException)
    def handle_http_error(err):
        return jsonify({"error": {"code": "HTTP_ERROR", "message": err.description}}), err.code

    @app.errorhandler(404)
    def handle_404(err):
        return jsonify({"error": {"code": "NOT_FOUND", "message": "The requested resource was not found"}}), 404

    @app.errorhandler(405)
    def handle_405(err):
        return jsonify({"error": {"code": "METHOD_NOT_ALLOWED", "message": "HTTP method not allowed for this endpoint"}}), 405

    @app.errorhandler(500)
    def handle_500(err):
        _log.error("500 on %s %s: %s\n%s", request.method, request.path, err,
                    traceback.format_exc())
        return jsonify({"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred"}}), 500

    @app.errorhandler(Exception)
    def handle_unhandled(err):
        _log.error("Unhandled exception on %s %s: %s\n%s",
                    request.method, request.path, err, traceback.format_exc())
        return jsonify({"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred"}}), 500
