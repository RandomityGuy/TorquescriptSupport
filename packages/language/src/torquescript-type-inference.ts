import type { AstNode, IndexManager } from 'langium';
import { AstUtils, WorkspaceCache } from 'langium';
import type { CommentProvider } from 'langium';
import { unwrapExpr } from './torquescript-expr-utils.js';
import type {
    ConsoleClassDecl, DatablockStmt, Expr, FnDecl, ObjectDecl, ObjectMember, VarExpr
} from './generated/ast.js';
import { isFnDecl, isObjectDecl, isSlotAssign, isStart, isVarExpr } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';

export interface InferredType {
    classDecl?: ConsoleClassDecl;
    /** Namespace names from a literal `class`/`superClass` field on the originating object - TorqueScript's own dynamic-namespace convention, checked one level deep. */
    extraNamespaces: string[];
    /** 'explicit' only for an unambiguous `@type` JSDoc override - the sole source confident enough to ever warn on. */
    source: 'explicit' | 'inferred';
}

const TYPE_TAG_PATTERN = /@type\s+(\S+)/;
const RETURNS_TAG_PATTERN = /@returns\s+(\S+)/;
const PARAM_TAG_PATTERN = /@param\s+(\S+)\s+(\S+)/g;
const CLASSES_BY_NAME_KEY = 'classes-by-name';
const NAMED_OBJECTS_BY_NAME_KEY = 'named-objects-by-name';

type NamedObjectNode = ObjectDecl | DatablockStmt;

/**
 * Best-effort, deliberately heuristic type inference for method-call (`.foo()`) resolution.
 * Not a real type system - TorqueScript is dynamically typed and this never claims certainty
 * beyond an explicit `@type` override. See torquescript.langium's PrimaryExprSuffix and the
 * ScopeProvider's method/field-via-suffix handling for how this feeds into completion/hover.
 *
 * A first version of this scanned `IndexManager.allElements(...)` fresh on every call, and
 * `findNearestAssignment` re-walked its whole enclosing function on every `%var` usage - on a
 * real ~1000-function project this dominated indexing time (16.6s -> 71s). Everything here is
 * now backed by a cached index built once (WorkspaceCache, auto-invalidated on any document
 * change - the same mechanism DefaultScopeProvider uses for its own global scope cache) or a
 * per-scope sorted-offset array searched by binary search (WeakMap keyed by the scope node,
 * naturally invalidated on reparse since the old node tree becomes unreachable).
 */
export class TorquescriptTypeInference {

    private readonly indexManager: IndexManager;
    private readonly commentProvider: CommentProvider;
    private readonly classesByNameCache: WorkspaceCache<string, Map<string, ConsoleClassDecl>>;
    private readonly namedObjectsByNameCache: WorkspaceCache<string, Map<string, NamedObjectNode>>;
    private readonly assignmentsByScope = new WeakMap<AstNode, Map<string, VarExpr[]>>();

    constructor(services: TorquescriptServices) {
        this.indexManager = services.shared.workspace.IndexManager;
        this.commentProvider = services.documentation.CommentProvider;
        this.classesByNameCache = new WorkspaceCache(services.shared);
        this.namedObjectsByNameCache = new WorkspaceCache(services.shared);
    }

    inferType(expr: AstNode | undefined): InferredType | undefined {
        const node = unwrapExpr(expr);
        return node ? this.inferFromNode(node, new Set()) : undefined;
    }

    /**
     * `visited` guards against infinite recursion through assignment chains that cycle back on
     * themselves - e.g. a self-assignment (`%x = %x;`) or a longer cycle (`%a = %b; ... %b = %a;`).
     * Real TorqueScript code has both patterns (self-assignment as a no-op/reset idiom is common),
     * and without this guard `findNearestAssignment` walking back into the same assignment it came
     * from causes unbounded recursion.
     */
    private inferFromNode(node: AstNode, visited: Set<VarExpr>): InferredType | undefined {
        if (isObjectDecl(node)) {
            return this.inferFromObjectDecl(node);
        }
        if (isVarExpr(node)) {
            if (visited.has(node)) {
                return undefined;
            }
            visited.add(node);
            return this.inferFromVarExpr(node, visited);
        }
        const expr = node as Partial<Expr>;
        if (expr.bareword) {
            return this.inferFromBareword(expr.bareword);
        }
        return undefined;
    }

    private inferFromObjectDecl(decl: ObjectDecl): InferredType | undefined {
        const classDecl = decl.classname?.ref;
        const extraNamespaces = this.getDynamicNamespaces(decl.members);
        if (!classDecl && extraNamespaces.length === 0) {
            return undefined;
        }
        return { classDecl, extraNamespaces, source: 'inferred' };
    }

    private inferFromDatablock(decl: DatablockStmt): InferredType | undefined {
        const classDecl = decl.classname?.ref;
        const extraNamespaces = this.getDynamicNamespacesFromSlots(decl.slots);
        if (!classDecl && extraNamespaces.length === 0) {
            return undefined;
        }
        return { classDecl, extraNamespaces, source: 'inferred' };
    }

    private getDynamicNamespaces(members: ObjectMember[]): string[] {
        return this.getDynamicNamespacesFromSlots(members.filter(isSlotAssign));
    }

    private getDynamicNamespacesFromSlots(slots: Array<{ slot?: { $refText: string }, value: Expr }>): string[] {
        const names: string[] = [];
        for (const slot of slots) {
            // `$refText` (raw source text), not `.ref.name` - `class`/`superClass` are dynamic
            // fields not statically declared on any class, so the reference itself never
            // resolves (that's expected, see the `slot` linking-error suppression), but the text
            // is always available regardless.
            const fieldName = slot.slot?.$refText?.toLowerCase();
            if (fieldName === 'class' || fieldName === 'superclass') {
                const literal = this.readStringLiteral(slot.value);
                if (literal) {
                    names.push(literal);
                }
            }
        }
        return names;
    }

    private readStringLiteral(expr: Expr | undefined): string | undefined {
        const node = unwrapExpr(expr);
        const text = node?.$cstNode?.text;
        if (text && text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
            return text.slice(1, -1);
        }
        return undefined;
    }

    private inferFromVarExpr(varExpr: VarExpr, visited: Set<VarExpr>): InferredType | undefined {
        const explicit = this.getExplicitType(varExpr);
        if (explicit) {
            return explicit;
        }

        const paramType = this.getParamExplicitType(varExpr);
        if (paramType) {
            return paramType;
        }

        const assignment = this.findNearestAssignment(varExpr);
        if (!assignment?.value || visited.has(assignment)) {
            return undefined;
        }
        visited.add(assignment);

        const assignmentExplicit = this.getExplicitType(assignment);
        if (assignmentExplicit) {
            return assignmentExplicit;
        }

        const rhs = unwrapExpr(assignment.value);
        if (!rhs) {
            return undefined;
        }
        if (isObjectDecl(rhs)) {
            return this.inferFromObjectDecl(rhs);
        }
        const rhsExpr = rhs as Partial<Expr>;
        if (rhsExpr.calledFunction?.ref) {
            return this.inferFromCall(rhsExpr.calledFunction.ref);
        }
        return this.inferFromNode(rhs, visited);
    }

    private inferFromCall(fnDecl: FnDecl): InferredType | undefined {
        const comment = this.commentProvider.getComment(fnDecl);
        const match = comment && RETURNS_TAG_PATTERN.exec(comment);
        return match ? { ...this.resolveTypeName(match[1]), source: 'inferred' } : undefined;
    }

    private inferFromBareword(name: string): InferredType | undefined {
        const node = this.getNamedObjectIndex().get(name.toLowerCase());
        if (!node) {
            return undefined;
        }
        return isObjectDecl(node) ? this.inferFromObjectDecl(node) : this.inferFromDatablock(node);
    }

    private getNamedObjectIndex(): Map<string, NamedObjectNode> {
        return this.namedObjectsByNameCache.get(NAMED_OBJECTS_BY_NAME_KEY, () => {
            const index = new Map<string, NamedObjectNode>();
            for (const description of this.indexManager.allElements('ObjectDecl')) {
                if (isObjectDecl(description.node)) {
                    index.set(description.name.toLowerCase(), description.node);
                }
            }
            for (const description of this.indexManager.allElements('DatablockStmt')) {
                if (description.node?.$type === 'DatablockStmt') {
                    index.set(description.name.toLowerCase(), description.node as DatablockStmt);
                }
            }
            return index;
        });
    }

    /**
     * `%var` function parameters are plain strings on `FnDecl.params.var` - never a VarExpr with
     * a `.value`, so `findNearestAssignment` can never find anything for them (there's nothing to
     * find: the value comes from the caller, not a local assignment). `@param %name ClassName` on
     * the function's own doc comment is the only way to type them. Same confidence level as
     * `@type` (both are explicit user assertions), so this also participates in the
     * unresolved-method warning.
     */
    private getParamExplicitType(varExpr: VarExpr): InferredType | undefined {
        const fnDecl = AstUtils.getContainerOfType(varExpr, isFnDecl);
        if (!fnDecl?.params?.var.includes(varExpr.var)) {
            return undefined;
        }
        const comment = this.commentProvider.getComment(fnDecl);
        if (!comment) {
            return undefined;
        }
        for (const match of comment.matchAll(PARAM_TAG_PATTERN)) {
            if (match[1] === varExpr.var) {
                return { ...this.resolveTypeName(match[2]), source: 'explicit' };
            }
        }
        return undefined;
    }

    private getExplicitType(node: AstNode): InferredType | undefined {
        const comment = this.commentProvider.getComment(node);
        const match = comment && TYPE_TAG_PATTERN.exec(comment);
        return match ? { ...this.resolveTypeName(match[1]), source: 'explicit' } : undefined;
    }

    /**
     * `@type`/`@param`/`@returns` may name either a real engine class (from the console dump) or
     * a purely dynamic ScriptObject-convention namespace that only exists as a string (e.g.
     * `class = "MyNamespace";` plus a bunch of `function MyNamespace::foo(){}` overrides, with no
     * real `ConsoleClassDecl` behind it at all). If it doesn't resolve to a real class, treat it
     * as a namespace name directly - the same fallback the `class`/`superClass` dynamic-overlay
     * detection already uses - rather than silently discarding the annotation.
     */
    private resolveTypeName(name: string): { classDecl?: ConsoleClassDecl; extraNamespaces: string[] } {
        const classDecl = this.findClassByName(name);
        // Original casing preserved for display (e.g. the unresolved-method warning) - matching
        // elsewhere is already case-insensitive at the point of comparison (getReceiverScope
        // lowercases when building its namespace set), same as the class/superClass overlay path.
        return classDecl ? { classDecl, extraNamespaces: [] } : { extraNamespaces: [name] };
    }

    private findClassByName(name: string): ConsoleClassDecl | undefined {
        return this.getClassIndex().get(name.toLowerCase());
    }

    private getClassIndex(): Map<string, ConsoleClassDecl> {
        return this.classesByNameCache.get(CLASSES_BY_NAME_KEY, () => {
            const index = new Map<string, ConsoleClassDecl>();
            for (const description of this.indexManager.allElements('ConsoleClassDecl')) {
                if (description.node) {
                    index.set(description.name.toLowerCase(), description.node as ConsoleClassDecl);
                }
            }
            return index;
        });
    }

    /**
     * Nearest preceding assignment to the same variable name within the enclosing function (or
     * top-level statement list). Document-order heuristic, not real dataflow analysis - branches,
     * loops, and reassignment-after-use aren't modeled. Deliberate simplification.
     */
    private findNearestAssignment(varExpr: VarExpr): VarExpr | undefined {
        const scope = AstUtils.getContainerOfType(varExpr, isFnDecl) ?? AstUtils.getContainerOfType(varExpr, isStart);
        if (!scope) {
            return undefined;
        }
        const candidates = this.getAssignmentIndex(scope).get(varExpr.var);
        if (!candidates || candidates.length === 0) {
            return undefined;
        }
        const usageOffset = varExpr.$cstNode?.offset ?? -1;
        // Binary search for the last entry whose offset is < usageOffset (candidates is sorted
        // ascending by offset).
        let lo = 0;
        let hi = candidates.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const offset = candidates[mid].$cstNode?.offset ?? -1;
            if (offset < usageOffset) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo > 0 ? candidates[lo - 1] : undefined;
    }

    /** Built once per enclosing scope, cached by node identity (auto-invalidated on reparse). */
    private getAssignmentIndex(scope: AstNode): Map<string, VarExpr[]> {
        let index = this.assignmentsByScope.get(scope);
        if (!index) {
            index = new Map();
            for (const node of AstUtils.streamAllContents(scope)) {
                if (isVarExpr(node) && node.value) {
                    const list = index.get(node.var);
                    if (list) {
                        list.push(node);
                    } else {
                        index.set(node.var, [node]);
                    }
                }
            }
            for (const list of index.values()) {
                list.sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0));
            }
            this.assignmentsByScope.set(scope, index);
        }
        return index;
    }
}
