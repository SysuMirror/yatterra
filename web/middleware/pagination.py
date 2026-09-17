"""Pagination utilities for API endpoints."""
from flask import request
from functools import wraps


def get_pagination_params():
    """Extract page and per_page from query string with defaults."""
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (ValueError, TypeError):
        page = 1
    try:
        per_page = min(100, max(1, int(request.args.get("per_page", 20))))
    except (ValueError, TypeError):
        per_page = 20
    return page, per_page


def paginate_query(query, page, per_page):
    """Apply offset/limit to a list or query result.
    Returns (items, total) where items is the page slice and total is the full count.
    """
    if isinstance(query, list):
        total = len(query)
        start = (page - 1) * per_page
        items = query[start:start + per_page]
        return items, total
    # For SQLAlchemy or similar query objects
    total = query.count()
    items = query.offset((page - 1) * per_page).limit(per_page).all()
    return items, total


def paginated_response(items, total, page, per_page, item_key="items"):
    """Build a standard paginated response dict."""
    return {
        item_key: items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
    }
