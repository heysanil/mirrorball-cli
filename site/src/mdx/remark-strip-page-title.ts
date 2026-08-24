import type { Root } from 'mdast'

/**
 * Removes the leading `# Title` from a page body.
 *
 * Every page in docs/ opens with an H1 that repeats its frontmatter title, because
 * that is what makes the file readable on GitHub. The docs layout renders the title
 * itself, so without this every page shows its heading twice — and the duplicate also
 * lands in the table of contents, where it sits above the sections it supposedly
 * contains.
 *
 * Only the first node is considered, and only when it is a depth-1 heading, so a
 * legitimate H1 further down a page would survive.
 */
export function remarkStripPageTitle() {
  return (tree: Root) => {
    const first = tree.children[0]
    if (first && first.type === 'heading' && first.depth === 1) {
      tree.children.shift()
    }
  }
}
