"""The one password policy, used wherever a password is set."""

from __future__ import annotations

PASSWORD_MIN = 10
PASSWORD_MAX = 128

# Passwords that satisfy the length, letter and digit rules but are in every cracking list
COMMON_PASSWORDS = frozenset(
    {
        "password123", "password1234", "password12345", "passw0rd123", "passw0rd1234",
        "p@ssw0rd123", "p@ssword123", "pa55word123", "password2024", "password2025",
        "password2026", "welcome123", "welcome1234", "welcome12345", "welcome2024",
        "welcome2025", "welcome2026", "qwerty12345", "qwerty123456", "qwertyuiop1",
        "qwertyuiop12", "qwertyuiop123", "1q2w3e4r5t", "1q2w3e4r5t6y", "q1w2e3r4t5",
        "1qaz2wsx3edc", "zaq12wsx3edc", "abc1234567", "abcd123456", "abcde12345",
        "abc123abc123", "a1b2c3d4e5", "a123456789", "1234567890a", "123456789a",
        "12345678910a", "qwe1234567", "iloveyou123", "iloveyou1234", "letmein123",
        "letmein1234", "admin12345", "admin123456", "administrator1", "changeme123",
        "changeme1234", "monkey12345", "dragon12345", "football123", "baseball123",
        "sunshine123", "princess123", "superman123", "michael12345", "trustno1trustno1",
        "summer2024!", "summer2025!", "winter2024!", "winter2025!", "spring2025!",
        "test123456", "testing12345", "temp123456", "temporary123", "default12345",
        "secret12345", "login12345", "master12345", "hello12345", "freedom12345",
    }
)


def password_problem(
    password: str, *, email: str | None = None, full_name: str | None = None
) -> str | None:
    """Return the first policy rule a password breaks, or None when it is acceptable.

    The policy: 10 to 128 characters, at least one letter and one digit, not containing
    the email's local part or the person's full name (ignoring case, with or without the
    spaces), and not one of the common passwords above. The name rules have no minimum
    length: a one-character email name or full name is refused like any other. Only an
    unknown or empty name is skipped, because there is nothing to look for.

    Args:
        password: The candidate, exactly as sent (spaces are significant).
        email: The account's email, when known.
        full_name: The account's full name, when known.

    Returns:
        A message that completes "password ...", naming the rule that failed.
    """
    if len(password) < PASSWORD_MIN:
        return f"must be at least {PASSWORD_MIN} characters"
    if len(password) > PASSWORD_MAX:
        return f"must be at most {PASSWORD_MAX} characters"
    if not any(char.isalpha() for char in password):
        return "must contain at least one letter"
    if not any(char.isdigit() for char in password):
        return "must contain at least one digit"
    # casefold, not lower: it is the case-insensitive form of every letter ("ß" and "SS")
    folded = password.casefold()
    local_part = (email or "").partition("@")[0].strip().casefold()
    if local_part and local_part in folded:
        return "must not contain the email name (the part before the @)"
    name = " ".join((full_name or "").casefold().split())
    if name and (name in folded or name.replace(" ", "") in folded):
        return "must not contain the person's name"
    if password.lower() in COMMON_PASSWORDS:
        return "is too common; choose one that is harder to guess"
    return None
