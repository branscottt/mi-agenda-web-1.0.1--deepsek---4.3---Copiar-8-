import re

with open('src/_legacy/script.js', 'r') as f:
    content = f.read()

# The confirm strings have actual newline characters embedded from a previous patch.
# In JavaScript, single-quoted '...' and backtick `...` strings should use \n escape.
# We need to replace actual newlines inside confirm() calls with \n escape sequences.

# Strategy: find all confirm() calls and fix newlines inside them
def fix_newlines_in_confirm(match):
    full = match.group(0)
    # Replace actual newlines with \n inside the confirm string
    # But only the newlines that are actual bytes, not already escaped
    fixed = full.replace('\n', '\\n')
    return fixed

# Fix confirm() calls with backtick strings
content = re.sub(
    r'confirm\(`[^`]+`\)',
    fix_newlines_in_confirm,
    content
)

# Fix confirm() calls with single-quoted strings
content = re.sub(
    r"confirm\('[^']+'\)",
    fix_newlines_in_confirm,
    content
)

with open('src/_legacy/script.js', 'w') as f:
    f.write(content)

print("Fixed all confirm() strings - newlines replaced with \\n escape")
