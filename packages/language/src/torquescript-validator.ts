import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { Expr, PrimaryExprSuffix, TorquescriptAstType } from './generated/ast.js';
import type { TorquescriptServices } from './torquescript-module.js';
import { TorquescriptTypeInference } from './torquescript-type-inference.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: TorquescriptServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.TorquescriptValidator;
    const checks: ValidationChecks<TorquescriptAstType> = {
        PrimaryExprSuffix: validator.checkExplicitTypeMethodResolves
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 *
 * Note: TorqueScript allows re-declaring a global function (the last one loaded wins at
 * runtime, similar to reassigning a variable) - this is normal, intentional behavior, not
 * something to flag as a duplicate/error. Go-to-definition on such a function instead surfaces
 * every declaration (see TorquescriptDefinitionProvider).
 */
export class TorquescriptValidator {

    private readonly typeInference: TorquescriptTypeInference;

    constructor(services: TorquescriptServices) {
        this.typeInference = new TorquescriptTypeInference(services);
    }

    /**
     * Method-call resolution is silent/assistive everywhere else (see
     * TorquescriptDocumentValidator, which suppresses the underlying linking error entirely) -
     * except here: an explicit `/** @type {ClassName} *\/` override is the one unambiguous,
     * user-asserted type source, so if the method truly isn't found anywhere (static hierarchy,
     * namespace-function overrides, or the dynamic class/superClass overlay), that's worth flagging.
     */
    checkExplicitTypeMethodResolves(node: PrimaryExprSuffix, accept: ValidationAcceptor): void {
        if (!node.calledMethod || node.calledMethod.ref) {
            return;
        }
        const receiverExpr = node.$container as Expr;
        if (receiverExpr.suffixes.indexOf(node) !== 0) {
            return;
        }
        const inferred = this.typeInference.inferType(receiverExpr);
        if (inferred?.source === 'explicit') {
            const typeName = inferred.classDecl?.name ?? inferred.extraNamespaces[0] ?? 'unknown';
            accept('warning', `Method '${node.calledMethod.$refText}' not found on type '${typeName}'.`, { node, property: 'calledMethod' });
        }
    }

}
