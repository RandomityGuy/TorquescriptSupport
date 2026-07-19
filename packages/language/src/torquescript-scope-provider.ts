import type { AstNode, AstNodeDescription, ReferenceInfo, Scope, URI } from 'langium';
import { AstUtils, DefaultScopeProvider, EMPTY_SCOPE, MultiMapScope, WorkspaceCache } from 'langium';
import type { ConsoleClassDecl, ConsoleFieldDecl, Expr, FnDecl, PrimaryExprSuffix } from './generated/ast.js';
import { isDatablockStmt, isFnDecl, isObjectDecl, isSlotAssign } from './generated/ast.js';
import { TorquescriptTypeInference } from './torquescript-type-inference.js';
import type { TorquescriptServices } from './torquescript-module.js';

const NAMESPACE_FUNCTIONS_CACHE_KEY = 'namespace-functions';

/** `.mis` files are mission scripts - their functions/objects are never callable from outside the mission, though they can freely call anything declared elsewhere. */
function isMisDocumentUri(uri: URI): boolean {
    return uri.path.toLowerCase().endsWith('.mis');
}

/**
 * TorqueScript function and class names are case-insensitive (e.g. `pushback()` resolves the
 * same as `pushBack()`), unlike Langium's default exact-match global scope lookup.
 */
export class TorquescriptScopeProvider extends DefaultScopeProvider {

    private readonly typeInference: TorquescriptTypeInference;
    /**
     * classname (lowercased) -> namespaced FnDecls. Rebuilding this by scanning every FnDecl in
     * the workspace on every single `.method()` reference (there can be thousands of both) was
     * the dominant cost in a real-project indexing benchmark. WorkspaceCache auto-invalidates on
     * any document change, same mechanism DefaultScopeProvider already uses for its own
     * `globalScopeCache`.
     */
    private readonly namespaceFunctionsCache: WorkspaceCache<string, Map<string, FnDecl[]>>;
    /** Per-`.mis`-document overlay scopes (its own otherwise-invisible exports) - see getGlobalScope. */
    private readonly misOwnScopeCache: WorkspaceCache<string, Scope>;

    constructor(services: TorquescriptServices) {
        super(services);
        this.typeInference = new TorquescriptTypeInference(services);
        this.namespaceFunctionsCache = new WorkspaceCache(services.shared);
        this.misOwnScopeCache = new WorkspaceCache(services.shared);
    }

    private getNamespaceFunctionIndex(): Map<string, FnDecl[]> {
        return this.namespaceFunctionsCache.get(NAMESPACE_FUNCTIONS_CACHE_KEY, () => {
            const index = new Map<string, FnDecl[]>();
            for (const description of this.indexManager.allElements('FnDecl')) {
                const node = description.node;
                if (node && isFnDecl(node) && node.classname) {
                    const key = node.classname.toLowerCase();
                    const list = index.get(key);
                    if (list) {
                        list.push(node);
                    } else {
                        index.set(key, [node]);
                    }
                }
            }
            return index;
        });
    }

    override getScope(context: ReferenceInfo): Scope {
        const referenceType = this.reflection.getReferenceType(context);
        if (referenceType === 'ConsoleFieldDecl') {
            if (isSlotAssign(context.container)) {
                return this.getDatablockFieldScope(context);
            }
            return this.getReceiverScope(context, 'field');
        }
        if (referenceType === 'ConsoleMethodDecl') {
            return this.getReceiverScope(context, 'method');
        }
        return super.getScope(context);
    }

    /**
     * `.mis` files are mission scripts - functions/objects/datablocks declared in one aren't
     * meant to be reachable from anywhere else (each mission is self-contained), but code inside
     * a `.mis` file can still freely call out to anything declared in ordinary `.cs`/`.tscript`
     * files, same as normal. The shared base scope excludes every `.mis` document's exports
     * entirely (cached once per reference type, reused by the common case - resolving from a
     * non-`.mis` document); a `.mis` document additionally gets its own exports layered on top
     * via `outerScope` chaining, visible only to references from that same document.
     */
    protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
        const baseScope = this.getNonMisGlobalScope(referenceType);
        const currentDocUri = AstUtils.getDocument(context.container).uri;
        if (!isMisDocumentUri(currentDocUri)) {
            return baseScope;
        }
        return this.getMisOwnScope(referenceType, currentDocUri, baseScope);
    }

    private getNonMisGlobalScope(referenceType: string): Scope {
        return this.globalScopeCache.get(referenceType, () => new MultiMapScope(
            [...this.indexManager.allElements(referenceType)].filter(d => !isMisDocumentUri(d.documentUri)),
            undefined,
            { caseInsensitive: true }
        ));
    }

    private getMisOwnScope(referenceType: string, docUri: URI, outerScope: Scope): Scope {
        const cacheKey = `${referenceType}::${docUri.toString()}`;
        return this.misOwnScopeCache.get(cacheKey, () => new MultiMapScope(
            [...this.indexManager.allElements(referenceType)].filter(d => d.documentUri.toString() === docUri.toString()),
            outerScope,
            { caseInsensitive: true }
        ));
    }

    /**
     * A datablock/object's assignable slots are exactly its resolved class's declared fields,
     * plus everything inherited up the parentClass chain - not the workspace-wide set of every
     * field on every class. TorqueScript also allows genuinely arbitrary dynamic fields beyond
     * that set, which is fine: an empty/partial scope here just means "not a known static field",
     * not an error (linking errors for `slot` are suppressed entirely, see the document validator).
     */
    private getDatablockFieldScope(context: ReferenceInfo): Scope {
        let node: AstNode | undefined = context.container;
        while (node && !isDatablockStmt(node) && !isObjectDecl(node)) {
            node = node.$container;
        }
        if (!node) {
            return EMPTY_SCOPE;
        }
        const classDecl = node.classname?.ref;
        if (!classDecl) {
            return EMPTY_SCOPE;
        }
        return this.createScopeForNodes(this.collectHierarchyFields(classDecl), undefined, { caseInsensitive: true });
    }

    private collectHierarchyFields(classDecl: ConsoleClassDecl): ConsoleFieldDecl[] {
        const fields: ConsoleFieldDecl[] = [];
        const seen = new Set<ConsoleClassDecl>();
        let current: ConsoleClassDecl | undefined = classDecl;
        while (current && !seen.has(current)) {
            seen.add(current);
            fields.push(...current.fields);
            current = current.parentClass?.ref;
        }
        return fields;
    }

    /**
     * `.methodName()`/`.fieldName` on an object receiver (`%obj.foo`, `new X().foo`, a named
     * bareword object, ...) - resolved via TorquescriptTypeInference's best-effort type guess.
     * Only the first `.` in a suffix chain is supported (`%obj.a().b()` - `.a` is type-aware,
     * `.b` is not, since we'd need to know `.a()`'s return type to keep going, which the engine's
     * free-text method signatures don't reliably provide). Silent/empty when the type can't be
     * guessed - never an error, matching the dynamic-field precedent above.
     */
    private getReceiverScope(context: ReferenceInfo, kind: 'field' | 'method'): Scope {
        const suffix = context.container as PrimaryExprSuffix;
        const receiverExpr = suffix.$container as Expr | undefined;
        if (!receiverExpr?.suffixes) {
            return EMPTY_SCOPE;
        }
        // During completion, the in-progress suffix (the one being completed) generally hasn't
        // been appended to `suffixes` yet - indexOf returns -1 for it. Treat "not found" as "at
        // the end" so a fresh completion right after the receiver (no other suffixes yet) still
        // counts as the first hop, while a second in-progress suffix after an already-committed
        // one is still correctly treated as chaining (and blocked).
        const rawIndex = receiverExpr.suffixes.indexOf(suffix);
        const effectiveIndex = rawIndex === -1 ? receiverExpr.suffixes.length : rawIndex;
        if (effectiveIndex !== 0) {
            return EMPTY_SCOPE;
        }

        const inferred = this.typeInference.inferType(receiverExpr);
        if (!inferred) {
            return EMPTY_SCOPE;
        }

        // Built manually (not via createScopeForNodes) because that relies on our NameProvider,
        // which gives FnDecl the *composite* `Namespace::func` name (needed for top-level
        // `Namespace::func()` call resolution) - but here, as a method candidate, it must be
        // looked up by its bare name (`.customMethod()`, not `.SimObject::customMethod()`).
        const descriptions: AstNodeDescription[] = [];
        const namespaceNames = new Set(inferred.extraNamespaces.map(n => n.toLowerCase()));
        const seen = new Set<ConsoleClassDecl>();
        const collectFromHierarchy = (start: ConsoleClassDecl | undefined): void => {
            let current = start;
            while (current && !seen.has(current)) {
                seen.add(current);
                namespaceNames.add(current.name.toLowerCase());
                for (const member of (kind === 'field' ? current.fields : current.methods)) {
                    descriptions.push(this.descriptions.createDescription(member, member.name));
                }
                current = current.parentClass?.ref;
            }
        };

        collectFromHierarchy(inferred.classDecl);
        // `class=`/`superClass=` are only ever processed by ScriptObject/ScriptGroup::onAdd() (see
        // usesScriptObjectConvention's doc comment) - so an object using them gets ScriptObject's
        // (and transitively SimObject's) real static fields/methods too, on top of whatever its
        // own literal declared class already contributes. Silently does nothing if the workspace's
        // console dump doesn't declare a "ScriptObject" class at all.
        if (inferred.usesScriptObjectConvention) {
            collectFromHierarchy(this.typeInference.findClassByName('ScriptObject'));
        }

        if (kind === 'method') {
            const namespaceFunctions = this.getNamespaceFunctionIndex();
            for (const namespaceName of namespaceNames) {
                for (const node of namespaceFunctions.get(namespaceName) ?? []) {
                    descriptions.push(this.descriptions.createDescription(node, node.name));
                }
            }
        }

        return this.createScope(descriptions, undefined, { caseInsensitive: true });
    }
}
