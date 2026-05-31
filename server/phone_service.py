import config
from datetime import datetime, timezone, timedelta
import random
import string


def send_sms_code(phone: str) -> str | None:
    code = generate_sms_code()
    if not config.TWILIO_ACCOUNT_SID or not config.TWILIO_AUTH_TOKEN or not config.TWILIO_PHONE_NUMBER:
        print(f"[DEV] SMS code for {phone}: {code}")
        return code
    try:
        from twilio.rest import Client
        client = Client(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN)
        body = f"Eon: ваш код подтверждения: {code}"
        client.messages.create(body=body, from_=config.TWILIO_PHONE_NUMBER, to=phone)
        return code
    except Exception:
        print(f"[DEV] SMS failed for {phone}, fallback code: {code}")
        return code


def generate_sms_code() -> str:
    return "".join(random.choices(string.digits, k=6))
