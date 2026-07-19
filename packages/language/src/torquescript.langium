grammar Torquescript


entry Start:
    (decls+=Decl)+;

Decl:
    Stmt | FnDecl | PackageDecl;

PackageDecl:
    'package' name=IDENT '{' (functions+=FnDecl)+ '}' ';';

FnDecl:
    'function' (classname=IDENT OP_COLONCOLON)? name=IDENT '(' params=VarList? ')' '{' StatementList '}';

VarList:
    var+=VAR (',' var+=VAR)*;

fragment StatementList:
    (statements+=Stmt)*;

Stmt:
    IfStmt 
    | WhileStmt 
    | ForStmt 
    | ForeachStmt
    | DatablockStmt 
    | SwitchStmt 
    | 'break' ';'
    | 'continue' ';'
    | 'return' (returnValue=Expr)? ';'
    | Expr ';'
;

DatablockStmt:
    'datablock' classname=[ConsoleClassDecl:IDENT] '(' name=IDENT ParentBlock ')' '{' slots+=SlotAssign+ '}' ';';

ObjectDecl:
    'new' ClassNameExpr '(' ('[' ObjectName ']' | ObjectName) ParentBlock ObjectArgs ')' ('{' members+=ObjectMember* '}')?
  | 'singleton' ClassNameExpr '(' ObjectName ParentBlock ObjectArgs ')' ('{' members+=ObjectMember* '}')?
;

ObjectMember:
    SlotAssign
  | objectDecl=ObjectDecl ';'
;

fragment ClassNameExpr:
    classname=[ConsoleClassDecl:IDENT] | '(' classnameExpr=Expr ')';

fragment ParentBlock:
    (':' parentName=IDENT)?;

fragment ObjectName:
    objectName=Expr?;

fragment ObjectArgs:
    (',' ExprList)?;

fragment StmtBlock:
    '{' StatementList '}'
   | Stmt;

SwitchStmt:
    ('switch' | 'switch$') '(' switchExpr=Expr ')' '{'
        cases+=CaseClause*
        defaultClause=DefaultClause?
    '}'
;

CaseClause:
    'case' caseExpr=CaseExpr ':' statements+=Stmt*
;

DefaultClause:
    'default' ':' statements+=Stmt*
;

CaseExpr:
    exprs+=Expr ('or' exprs+=Expr)*
;

IfStmt:
    'if' '(' cond=Expr ')' StmtBlock ('else' StmtBlock)?
;

WhileStmt:
    'while' '(' cond=Expr ')' StmtBlock
   | 'do' StmtBlock 'while' '(' cond=Expr ')'
;

ForStmt:
    'for' '(' loopInit=Expr? ';' loopCond=Expr? ';' loopUpdate=Expr? ')' StmtBlock
;

ForeachStmt:
    ('foreach' | 'foreach$') '(' Expr 'in' Expr ')' StmtBlock
;

AssertExpr:
    'assert' '(' assertExpr=Expr (',' STRING)? ')'
;

SlotAssign:
    slot=[ConsoleFieldDecl:IDENT] ('[' index=ExprList ']')? '=' value=Expr ';'
   | 'datablock' '=' value=Expr ';'
;

ExprList:
    expr+=Expr (',' expr+=Expr)*;

Expr:
    TernaryExpr;


TernaryExpr:
    cond=OrExpr ('?' thenExpr=Expr ':' elseExpr=Expr)?
;

OrExpr:
    left=AndExpr (OP_OR right+=AndExpr)*
;

AndExpr:
    left=EqualityExpr (OP_AND right+=EqualityExpr)*
;

EqualityExpr:
    left=RelationalExpr ((OP_EQ | OP_NE | OP_STREQ | OP_STRNE) right+=RelationalExpr)*
;

RelationalExpr:
    left=ShiftExpr (('<' | '>' | OP_LE | OP_GE) right+=ShiftExpr)*
;

ShiftExpr:
    left=AddExpr ((OP_SHL | OP_SHR) right+=AddExpr)*
;

AddExpr:
    left=MulExpr (('+' | '-' | OP_CAT) right+=MulExpr)*
;

MulExpr:
    left=BitwiseExpr (('*' | '/' | '%' ) right+=BitwiseExpr)*
;

// If you want bitwise precedence separately:
BitwiseExpr:
    left=UnaryExpr (('^' | '&' | '|') right+=UnaryExpr)*
;

UnaryExpr infers Expr:
    ('!' | '~' | '-' | '*') operand=UnaryExpr
  | PostfixExpr
;

PostfixExpr infers Expr:
    PrimaryAtom suffixes+=PrimaryExprSuffix*
;

PrimaryAtom infers Expr:
    calledFunction=[FnDecl:QualifiedName] '(' ExprList? ')'
  | bareword=QualifiedName
  | ObjectDecl
  | VarExpr
  | '(' Expr ')'
  | TAG
  | FLTCONST
  | INTCONST
  | STRING
;

QualifiedName returns string:
    IDENT (OP_COLONCOLON IDENT)?;

VarExpr:
    var=VAR (
        '[' index=ExprList ']' (assign=AssignOpStruct | '=' value=Expr)?
      | assign=AssignOpStruct
      | '=' value=Expr
    )?
;

PrimaryExprSuffix:
    '.' calledMethod=[ConsoleMethodDecl:IDENT] '(' args=ExprList? ')'
  | '.' field=[ConsoleFieldDecl:IDENT] (
        '[' index=ExprList ']' (assign=AssignOpStruct | '=' value=Expr | '=' '{' arrayInit=ExprList '}')?
      | assign=AssignOpStruct
      | '=' value=Expr
      | '=' '{' arrayInit=ExprList '}'
    )?
  | (OP_INTNAME | OP_INTNAMER) ClassNameExpr
;

AssignOpStruct:
    OP_PLUSPLUS
   | OP_MINUSMINUS
   | (OP_PLASN | OP_MIASN | OP_MLASN | OP_DVASN | OP_MODASN | OP_ANDASN | OP_XORASN | OP_ORASN | OP_SLASN | OP_SRASN) value=Expr
;

interface ConsoleClassDecl {
    name: string;
    parentClass?: @ConsoleClassDecl;
    methods: ConsoleMethodDecl[];
    fields: ConsoleFieldDecl[];
}

interface ConsoleMethodDecl {
    name: string;
    signature?: string;
}

interface ConsoleFieldDecl {
    name: string;
    fieldType?: string;
}

interface ConsoleApiModel {
    classes: ConsoleClassDecl[];
    functions: FnDecl[];
}

terminal fragment DIGIT: /[0-9]/;
terminal fragment INTEGER: DIGIT+;
terminal fragment LETTER: /[A-Za-z_]/;
terminal fragment FILECHAR: /[A-Za-z_.]/;
terminal fragment VARMID: /[:A-Za-z0-9_]/;
terminal fragment IDTAIL: /[A-Za-z0-9_]/;
terminal fragment VARTAIL: VARMID* IDTAIL;
terminal fragment HEXDIGIT: /[a-zA-F0-9]/;
terminal fragment EscapeSequence:
    '\\x' HEXDIGIT+
    | '\\c' /[0-9opr]+/
    | '\\' /./;

terminal OP_EQ: '==';
terminal OP_NE: '!=';
terminal OP_GE: '>=';
terminal OP_LE: '<=';
terminal OP_AND: '&&';
terminal OP_OR: '||';
terminal OP_INTNAMER: '-->';
terminal OP_COLONCOLON: '::';
terminal OP_MINUSMINUS: '--';
terminal OP_PLUSPLUS: '++';
terminal OP_STREQ: '$=';
terminal OP_STRNE: '!$=';
terminal OP_SLASN: '<<=';
terminal OP_SRASN: '>>=';
terminal OP_SHL: '<<';
terminal OP_SHR: '>>';
terminal OP_PLASN: '+=';
terminal OP_MIASN: '-=';
terminal OP_MLASN: '*=';
terminal OP_DVASN: '/=';
terminal OP_MODASN: '%=';
terminal OP_ANDASN: '&=';
terminal OP_XORASN: '^=';
terminal OP_ORASN: '|=';
terminal OP_INTNAME: '->';
terminal OP_CAT: 'NL' | 'TAB' | 'SPC' | '@';
hidden terminal WS: /\s+/;
terminal STRING: '"' (/[^"\\\r\n"]/ | EscapeSequence)* '"';
terminal TAG: '\'' (/[^'\\\r\n"]/ | EscapeSequence)* '\'';
terminal FLTCONST returns number:
     (INTEGER '.' INTEGER) | (INTEGER ('.' INTEGER)? /[eE]/ /[+-]/? INTEGER) | ('.' INTEGER (/[eE]/ /[+-]/? INTEGER)?);
terminal VAR: /[$%]/ LETTER VARTAIL*;
terminal IDENT: LETTER IDTAIL*;
terminal INTCONST returns number: '0' /[xX]/ HEXDIGIT+ | INTEGER | 'true' | 'false';


hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;