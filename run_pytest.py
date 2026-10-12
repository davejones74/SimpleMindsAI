import subprocess
import sys

result = subprocess.run(
    ['python', '-m', 'pytest', '..\\test\\*.test.js'],
    cwd='E:\\Development\\Repositories\\SimpleMindsAI\\python',
    capture_output=True,
    text=True,
)

with open('..\\pytest-results-py.txt', 'w') as f:
    f.write(result.stdout)
    f.write(result.stderr)

print(f'Return code: {result.returncode}')
print(f'stdout lines: {len(result.stdout.splitlines())}')
print(f'stderr lines: {len(result.stderr.splitlines())}')