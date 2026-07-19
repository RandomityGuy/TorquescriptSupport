import type { AstNode } from 'langium';
import {
    isAddExpr, isAndExpr, isBitwiseExpr, isEqualityExpr, isMulExpr,
    isOrExpr, isRelationalExpr, isShiftExpr, isTernaryExpr
} from './generated/ast.js';
import type { Expr, ObjectDecl } from './generated/ast.js';

/**
 * TorqueScript's operator-precedence expression grammar creates a real wrapper node at every
 * precedence level for every expression, even a bare `%x` (TernaryExpr -> OrExpr -> AndExpr ->
 * EqualityExpr -> RelationalExpr -> ShiftExpr -> AddExpr -> MulExpr -> BitwiseExpr -> the merged
 * Expr shape). Descends through any of those levels that have no actual operator applied (an
 * empty `right` array, or no then/else branch) down to the real atom - an ObjectDecl, VarExpr,
 * a call (`calledFunction` set), a bareword, or a literal.
 */
export function unwrapExpr(expr: AstNode | undefined): AstNode | undefined {
    let node = expr;
    while (node) {
        if (isTernaryExpr(node)) {
            if (node.thenExpr || node.elseExpr) {
                return node;
            }
            node = node.cond;
        } else if (isOrExpr(node) || isAndExpr(node) || isEqualityExpr(node) || isRelationalExpr(node)
            || isShiftExpr(node) || isAddExpr(node) || isMulExpr(node) || isBitwiseExpr(node)) {
            if (node.right.length > 0) {
                return node;
            }
            node = node.left;
        } else {
            return node;
        }
    }
    return node;
}

/** True if this (already-unwrapped) node represents an actual unary operator application (`!x`, `-x`, ...). */
export function isUnaryOperation(node: AstNode): node is Expr {
    return 'operand' in node && (node as Expr).operand !== undefined;
}

/** The registered name of `new ClassName(SomeBareword)`/`singleton ClassName(SomeBareword)`, if it's a plain bareword (not a computed expression). */
export function getObjectBareword(node: ObjectDecl): string | undefined {
    const unwrapped = unwrapExpr(node.objectName);
    return unwrapped && 'bareword' in unwrapped ? (unwrapped as { bareword?: string }).bareword : undefined;
}
