import type { CstNode, IndexManager, LangiumDocument } from 'langium';
import { AstUtils } from 'langium';
import type { GoToLink } from 'langium/lsp';
import { DefaultDefinitionProvider } from 'langium/lsp';
import type { Expr } from './generated/ast.js';
import { isFnDecl } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';
import { TorquescriptTypeInference } from './torquescript-type-inference.js';

/**
 * TorqueScript allows re-declaring a global function - the last one loaded wins at runtime,
 * similar to reassigning a variable - so a `calledFunction` reference only ever resolves to one
 * of possibly several same-named declarations. The default DefinitionProvider would only jump to
 * that one. This adds every other declaration sharing the same composite name as additional
 * go-to-definition targets, so all occurrences are reachable rather than just the resolved one.
 *
 * Also adds go-to-definition for bareword object usages (`PlayMissionGui.onWake();`) - these
 * aren't a formal Langium cross-reference (see torquescript-type-inference.ts's `bareword` doc
 * comment for why: the same production also parses an object's *own* declared name, so making it
 * a real cross-reference would make every `new X(Name)` try to resolve "Name" against itself and
 * fail), so the default reference-based mechanism finds nothing for them - this manually looks
 * them up through the same named-object index TorquescriptTypeInference already maintains.
 */
export class TorquescriptDefinitionProvider extends DefaultDefinitionProvider {

    private readonly indexManager: IndexManager;
    private readonly typeInference: TorquescriptTypeInference;

    constructor(services: TorquescriptServices) {
        super(services);
        this.indexManager = services.shared.workspace.IndexManager;
        this.typeInference = new TorquescriptTypeInference(services);
    }

    protected override findLinks(source: CstNode): GoToLink[] {
        const links = super.findLinks(source);
        if (links.length === 0) {
            return this.findBarewordLinks(source);
        }

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

    private findBarewordLinks(source: CstNode): GoToLink[] {
        const node = source.astNode as Partial<Expr> | undefined;
        if (!node?.bareword) {
            return [];
        }
        const target = this.typeInference.findNamedObject(node.bareword);
        if (!target) {
            return [];
        }
        const targetCstNode = this.nameProvider.getNameNode(target) ?? target.$cstNode;
        if (!targetCstNode) {
            return [];
        }
        return [{ source, target: targetCstNode, targetDocument: AstUtils.getDocument(target) }];
    }
}
