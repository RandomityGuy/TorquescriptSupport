import type { AstNode, IndexManager } from 'langium';
import { AstUtils, WorkspaceCache } from 'langium';
import type { CommentProvider } from 'langium';
import { getObjectBareword, unwrapExpr } from './torquescript-expr-utils.js';
import type {
    ConsoleClassDecl, DatablockStmt, Expr, FnDecl, ObjectDecl, ObjectMember, VarExpr
} from './generated/ast.js';
import { isFnDecl, isObjectDecl, isSlotAssign, isStart, isVarExpr } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';

export interface InferredType {
    classDecl?: ConsoleClassDecl;
    /** Namespace names from a literal `class`/`superClass` field on the originating object - TorqueScript's own dynamic-namespace convention, checked one level deep. */
    extraNamespaces: string[];
    /**
     * True when `class=`/`superClass=` was actually used (and not bypassed - see
     * `classNameLinkingBypassed`) - only `ScriptObject`/`ScriptGroup::onAdd()` ever process those
     * fields, so using them at all implies the object behaves like a `ScriptObject` (and
     * transitively `SimObject`) for field/method purposes too, regardless of its literal declared
     * C++ class. Never set for datablocks - `GameBaseData::onAdd()` links `className` itself
     * directly and never calls `ScriptObject::onAdd()`, so the same implication doesn't hold there.
     */
    usesScriptObjectConvention?: boolean;
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

    /**
     * `GuiControl` and `TCPObject` (and its subclasses, e.g. `HTTPObject`) override `onAdd()` to
     * link their own real C++ class namespace straight to the object's name - unlike
     * `ScriptObject`/`ScriptGroup::onAdd()` (what other objects fall back to), they never read
     * `className`/`superClassName` at all. Setting `class=`/`superClass=` on one of these has no
     * runtime effect, so both fields are skipped entirely for objects in that hierarchy - not
     * just `superClass=` like the datablock case (see `inferFromDatablock`), where `className` is
     * still honored.
     */
    private static readonly CLASSNAME_LINK_BYPASS_BASES = new Set(['guicontrol', 'tcpobject']);

    private classNameLinkingBypassed(classDecl: ConsoleClassDecl | undefined): boolean {
        let current = classDecl;
        const seen = new Set<ConsoleClassDecl>();
        while (current && !seen.has(current)) {
            if (TorquescriptTypeInference.CLASSNAME_LINK_BYPASS_BASES.has(current.name.toLowerCase())) {
                return true;
            }
            seen.add(current);
            current = current.parentClass?.ref;
        }
        return false;
    }

    private inferFromObjectDecl(decl: ObjectDecl): InferredType | undefined {
        const classDecl = decl.classname?.ref;
        const extraNamespaces = this.classNameLinkingBypassed(classDecl) ? [] : this.getDynamicNamespaces(decl.members);
        const usesScriptObjectConvention = extraNamespaces.length > 0;
        // Every `onAdd()` variant - regardless of whether it honors class=/superClass= - ends by
        // linking the object's own registered name in as the innermost namespace
        // (`Con::linkNamespaces(parent, name); mNameSpace = Con::lookupNamespace(name);`). That's
        // what makes per-dialog overrides like `function PlayMissionGui::onWake(%this){}` resolve
        // on an object created as `new GuiControl(PlayMissionGui)` - universal across every class,
        // so it's added unconditionally, not gated behind classNameLinkingBypassed.
        const ownName = getObjectBareword(decl);
        if (ownName) {
            extraNamespaces.push(ownName);
        }
        if (!classDecl && extraNamespaces.length === 0) {
            return undefined;
        }
        return { classDecl, extraNamespaces, usesScriptObjectConvention, source: 'inferred' };
    }

    /**
     * Datablocks (`GameBaseData`-derived classes) only ever link their namespace through
     * `className` - the engine's `GameBaseData::onAdd()` never reads `mSuperClassName` at all
     * (unlike `ScriptObject`/`ScriptGroup::onAdd()`, which plain `new`/`singleton` objects fall
     * back to and which do honor both `className` and `superClassName`). Including `superClass=`
     * here would resolve `.method()` calls through a namespace TorqueScript itself never links for
     * a datablock.
     */
    private inferFromDatablock(decl: DatablockStmt): InferredType | undefined {
        const classDecl = decl.classname?.ref;
        const extraNamespaces = this.getDynamicNamespacesFromSlots(decl.slots, { includeSuperClass: false });
        // Same universal name-link as inferFromObjectDecl - GameBaseData::onAdd() also ends with
        // `Con::linkNamespaces(className, name); mNameSpace = Con::lookupNamespace(name);`, so a
        // datablock's own name works as a namespace too (`function MyDataName::method(){}`).
        extraNamespaces.push(decl.name);
        if (!classDecl && extraNamespaces.length === 0) {
            return undefined;
        }
        return { classDecl, extraNamespaces, source: 'inferred' };
    }

    private getDynamicNamespaces(members: ObjectMember[]): string[] {
        return this.getDynamicNamespacesFromSlots(members.filter(isSlotAssign), { includeSuperClass: true });
    }

    private getDynamicNamespacesFromSlots(
        slots: Array<{ slot?: { $refText: string }, value: Expr }>,
        options: { includeSuperClass: boolean }
    ): string[] {
        const names: string[] = [];
        for (const slot of slots) {
            // `$refText` (raw source text), not `.ref.name` - `class`/`superClass` are dynamic
            // fields not statically declared on any class, so the reference itself never
            // resolves (that's expected, see the `slot` linking-error suppression), but the text
            // is always available regardless.
            const fieldName = slot.slot?.$refText?.toLowerCase();
            if (fieldName === 'class' || (options.includeSuperClass && fieldName === 'superclass')) {
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
        const node = this.findNamedObject(name);
        if (!node) {
            return undefined;
        }
        return isObjectDecl(node) ? this.inferFromObjectDecl(node) : this.inferFromDatablock(node);
    }

    /** The `ObjectDecl`/`DatablockStmt` registered under this name, if any - used for go-to-definition on bareword usages (`PlayMissionGui.onWake();`), which aren't a formal Langium cross-reference (see torquescript-definition-provider.ts). */
    findNamedObject(name: string): NamedObjectNode | undefined {
        return this.getNamedObjectIndex().get(name.toLowerCase());
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
     * `@type`/`@param`/`@returns` may name a real engine class (from the console dump), a
     * specific named object/datablock elsewhere in the project (e.g. `@type MPCoolEndGameDlg`
     * naming a GUI dialog registered as `new GuiControl(MPCoolEndGameDlg) {...}` in a `.gui`
     * file), or a purely dynamic ScriptObject-convention namespace that only exists as a string
     * (`class = "MyNamespace";` plus `function MyNamespace::foo(){}` overrides, no backing
     * declaration at all). Checked in that order: a real class always wins if the name happens to
     * collide; otherwise, if a named object matches, its *actual* inferred type (real class
     * hierarchy included, not just its own namespace) is what the annotation should mean - without
     * this, `@type MPCoolEndGameDlg` would only ever check script-level `MPCoolEndGameDlg::...`
     * overrides and completely miss built-in methods declared on the real class the dialog is an
     * instance of. Falls back to a bare namespace name only when neither matches.
     */
    private resolveTypeName(name: string): { classDecl?: ConsoleClassDecl; extraNamespaces: string[]; usesScriptObjectConvention?: boolean } {
        const classDecl = this.findClassByName(name);
        if (classDecl) {
            // Original casing preserved for display (e.g. the unresolved-method warning) -
            // matching elsewhere is already case-insensitive at the point of comparison.
            return { classDecl, extraNamespaces: [] };
        }
        const namedObject = this.findNamedObject(name);
        if (namedObject) {
            const objectType = isObjectDecl(namedObject)
                ? this.inferFromObjectDecl(namedObject)
                : this.inferFromDatablock(namedObject);
            if (objectType) {
                return {
                    classDecl: objectType.classDecl,
                    extraNamespaces: objectType.extraNamespaces,
                    usesScriptObjectConvention: objectType.usesScriptObjectConvention
                };
            }
        }
        return { extraNamespaces: [name] };
    }

    /** Public for the ScopeProvider's `ScriptObject` fallback - see getReceiverScope. */
    findClassByName(name: string): ConsoleClassDecl | undefined {
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
