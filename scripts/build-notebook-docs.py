"""Convert the example notebooks into Markdown pages for the docs site.

Zensical cannot render ``.ipynb`` files, so this writes one page per notebook in
``notebooks/`` to ``docs/notebooks/``. Markdown cells are copied as is, code
cells become fenced Python blocks, and any saved text or image outputs are kept.
Run it before ``zensical build``.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "notebooks"
OUT = ROOT / "docs" / "notebooks"
REPO = "https://github.com/opengeos/geolibre-nasa-opera/blob/main/notebooks"


def cell_source(cell):
    """Return a notebook cell's source as one string.

    Args:
        cell: A notebook cell dict.

    Returns:
        The cell source with surrounding blank lines removed.
    """
    source = cell.get("source", "")
    if isinstance(source, list):
        source = "".join(source)
    return source.strip("\n")


def render_outputs(outputs):
    """Render saved code-cell outputs as Markdown.

    Args:
        outputs: The ``outputs`` list of a code cell.

    Returns:
        A list of Markdown blocks; empty when the cell has no outputs.
    """
    blocks = []
    for output in outputs:
        data = output.get("data", {})
        if "image/png" in data:
            blocks.append(f"![output](data:image/png;base64,{data['image/png'].strip()})")
            continue
        text = output.get("text") or data.get("text/plain")
        if text:
            text = "".join(text) if isinstance(text, list) else text
            blocks.append(f"```text\n{text.rstrip()}\n```")
    return blocks


def convert(path):
    """Convert one notebook to Markdown.

    Args:
        path: Path to the ``.ipynb`` file.

    Returns:
        The page content as a string.
    """
    notebook = json.loads(path.read_text(encoding="utf-8"))
    blocks = []
    for cell in notebook["cells"]:
        source = cell_source(cell)
        if cell["cell_type"] == "markdown" and source:
            blocks.append(source)
        elif cell["cell_type"] == "code" and source:
            blocks.append(f"```python\n{source}\n```")
            blocks.extend(render_outputs(cell.get("outputs", [])))
    source_link = (
        f"[:material-download: Download this notebook]({REPO}/{path.name})"
        "{ .md-button }"
    )
    blocks.append(source_link)
    headings = [
        line[2:]
        for cell in notebook["cells"]
        if cell["cell_type"] == "markdown"
        for line in cell_source(cell).splitlines()
        if line.startswith("# ")
    ]
    title = headings[0] if headings else path.stem
    front_matter = f"---\ntitle: {title}\nicon: lucide/notebook\n---"
    return "\n\n".join([front_matter, *blocks]) + "\n"


def main():
    """Write a Markdown page for every notebook in ``notebooks/``."""
    OUT.mkdir(parents=True, exist_ok=True)
    for path in sorted(SRC.glob("*.ipynb")):
        target = OUT / f"{path.stem}.md"
        target.write_text(convert(path), encoding="utf-8")
        print(f"wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
