import type { CstNode, IndexManager, LangiumDocument } from 'langium';
import { AstUtils } from 'langium';
import type { GoToLink, LangiumServices } from 'langium/lsp';
import { DefaultDefinitionProvider } from 'langium/lsp';
import { isFnDecl } from './generated/ast.js';

/**
 * TorqueScript allows re-declaring a global function - the last one loaded wins at runtime,
 * similar to reassigning a variable - so a `calledFunction` reference only ever resolves to one
 * of possibly several same-named declarations. The default DefinitionProvider would only jump to
 * that one. This adds every other declaration sharing the same composite name as additional
 * go-to-definition targets, so all occurrences are reachable rather than just the resolved one.
 */
export class TorquescriptDefinitionProvider extends DefaultDefinitionProvider {

    private readonly indexManager: IndexManager;

    constructor(services: LangiumServices) {
        super(services);
        this.indexManager = services.shared.workspace.IndexManager;
    }

    protected override findLinks(source: CstNode): GoToLink[] {
        const links = super.findLinks(source);
        const seen = new Set(links.map(link => `${link.targetDocument.uri.toString()}#${link.target.offset}`));
        const extraLinks: GoToLink[] = [];

        for (const link of links) {
            const targetNode = link.target.astNode;
            if (!isFnDecl(targetNode)) {
                continue;
            }
            const name = this.nameProvider.getName(targetNode);
            if (!name) {
                continue;
            }
            for (const description of this.indexManager.allElements('FnDecl')) {
                if (description.name !== name || !description.node?.$cstNode) {
                    continue;
                }
                const otherNode = description.node;
                const otherTargetDocument: LangiumDocument = AstUtils.getDocument(otherNode);
                const otherCstNode = this.nameProvider.getNameNode(otherNode) ?? otherNode.$cstNode;
                if (!otherCstNode) {
                    continue;
                }
                const key = `${otherTargetDocument.uri.toString()}#${otherCstNode.offset}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                extraLinks.push({ source: link.source, target: otherCstNode, targetDocument: otherTargetDocument });
            }
        }

        return [...links, ...extraLinks];
    }
}
