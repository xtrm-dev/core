/**
 * Tiny safe XML builder for bd description payloads.
 *
 * Substrate (specialists-roadmap D30) expects deterministic XML tags inside
 * the bd description so the dispatcher's Stage-1 validator can parse them.
 * We never accept raw user input without escaping; we never construct via
 * template-string concatenation.
 *
 * Output is intentionally minimal: no namespaces, no attributes for now,
 * 2-space indent, LF newlines.
 */

export interface XmlNode {
    tag: string;
    children?: Array<XmlNode | string>;
}

export function elem(tag: string, children?: Array<XmlNode | string>): XmlNode {
    return { tag, children };
}

export function text(t: string): string {
    return t;
}

export function render(node: XmlNode, indent = 0): string {
    const pad = '  '.repeat(indent);
    if (!node.children || node.children.length === 0) {
        return `${pad}<${node.tag}/>`;
    }
    const allText = node.children.every((c) => typeof c === 'string');
    if (allText) {
        const body = (node.children as string[]).map(escape).join('').trim();
        if (body.length === 0) return `${pad}<${node.tag}/>`;
        if (!body.includes('\n') && body.length < 80) {
            return `${pad}<${node.tag}>${body}</${node.tag}>`;
        }
        return `${pad}<${node.tag}>\n${reindentText(body, indent + 1)}\n${pad}</${node.tag}>`;
    }
    const inner = node.children.map((c) => {
        if (typeof c === 'string') return reindentText(escape(c), indent + 1);
        return render(c, indent + 1);
    }).join('\n');
    return `${pad}<${node.tag}>\n${inner}\n${pad}</${node.tag}>`;
}

export function escape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function reindentText(s: string, indentLevel: number): string {
    const pad = '  '.repeat(indentLevel);
    return s
        .split('\n')
        .map((line) => (line.trim().length === 0 ? '' : pad + line.trim()))
        .join('\n');
}

/** Convenience: build a `<bullets>` block from a string[] as `<item>…</item>` children. */
export function bullets(items: string[]): XmlNode[] {
    return items.map((i) => elem('item', [i]));
}
