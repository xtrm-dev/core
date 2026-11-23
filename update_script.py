
def read_file(path):
    with open(path, 'r') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w') as f:
        f.write(content)

# We will write out the exact content for README.md, project-skills.md, skills.md, and hooks/README.md.
