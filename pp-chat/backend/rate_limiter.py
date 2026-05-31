from functools import wraps
from collections import defaultdict
from flask import request, jsonify
import time
import config

_limits = defaultdict(list)


def rate_limit(max_req: int, window: int):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            ip = request.remote_addr or "unknown"
            key = f"{ip}:{f.__name__}"
            now = time.time()
            _limits[key] = [t for t in _limits.get(key, []) if now - t < window]
            if len(_limits[key]) >= max_req:
                return jsonify({"error": "Слишком много запросов. Попробуйте позже."}), 429
            _limits[key].append(now)
            return f(*args, **kwargs)
        return wrapper
    return decorator
