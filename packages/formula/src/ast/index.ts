/**
 * Expression AST (PLAN §21 "represent rules as a safe AST rather than JavaScript code",
 * PLAN §22 "use a parser/AST"). The evaluator walks these nodes only — the source text is
 * never compiled, `eval`-ed or handed to a Function constructor.
 */
export type UnaryOperator = '-' | '+' | '!';

export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type LogicalOperator = '&&' | '||';

export type AstNode =
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'identifier'; name: string }
  | { kind: 'array'; elements: AstNode[] }
  | { kind: 'unary'; operator: UnaryOperator; operand: AstNode }
  | { kind: 'binary'; operator: BinaryOperator; left: AstNode; right: AstNode }
  | { kind: 'logical'; operator: LogicalOperator; left: AstNode; right: AstNode }
  | { kind: 'conditional'; test: AstNode; consequent: AstNode; alternate: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] }
  | { kind: 'member'; object: AstNode; property: string }
  | { kind: 'index'; object: AstNode; index: AstNode };

export type LiteralValue = string | number | boolean | null;

export type AstNodeKind = AstNode['kind'];

export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set(['true', 'false', 'null']);

export function literal(value: LiteralValue): AstNode {
  return { kind: 'literal', value };
}

export function callNode(name: string, args: AstNode[]): AstNode {
  return { kind: 'call', name, args };
}

export function binaryNode(operator: BinaryOperator, left: AstNode, right: AstNode): AstNode {
  return { kind: 'binary', operator, left, right };
}

export function countNodes(node: AstNode): number {
  switch (node.kind) {
    case 'literal':
    case 'identifier':
      return 1;
    case 'array':
      return node.elements.reduce((total, element) => total + countNodes(element), 1);
    case 'unary':
      return 1 + countNodes(node.operand);
    case 'binary':
    case 'logical':
      return 1 + countNodes(node.left) + countNodes(node.right);
    case 'conditional':
      return 1 + countNodes(node.test) + countNodes(node.consequent) + countNodes(node.alternate);
    case 'call':
      return node.args.reduce((total, arg) => total + countNodes(arg), 1);
    case 'member':
      return 1 + countNodes(node.object);
    case 'index':
      return 1 + countNodes(node.object) + countNodes(node.index);
  }
}

/** Depth-first walk used to check every call/identifier against the allowlist before saving metadata. */
export function forEachNode(node: AstNode, visit: (current: AstNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'literal':
    case 'identifier':
      return;
    case 'array':
      for (const element of node.elements) forEachNode(element, visit);
      return;
    case 'unary':
      forEachNode(node.operand, visit);
      return;
    case 'binary':
    case 'logical':
      forEachNode(node.left, visit);
      forEachNode(node.right, visit);
      return;
    case 'conditional':
      forEachNode(node.test, visit);
      forEachNode(node.consequent, visit);
      forEachNode(node.alternate, visit);
      return;
    case 'call':
      for (const arg of node.args) forEachNode(arg, visit);
      return;
    case 'member':
      forEachNode(node.object, visit);
      return;
    case 'index':
      forEachNode(node.object, visit);
      forEachNode(node.index, visit);
      return;
  }
}
