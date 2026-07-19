# [Warning: This extension was written entirely with the help of AI]

# Torquescript Support
This plugin adds support for Torquescript to VSCode, providing features like:
- Syntax Highlighting: borrowed from [Torquescript](https://marketplace.visualstudio.com/items?itemName=Torque3D.torquescript)
- Syntax Checking
- Go to Definition
- Find All References
- Signature Help
- Workspace Symbols
- Document Symbols
- Outline
- Type Hints

# Usage
Apply the following fix to your Torque game: https://gist.github.com/RandomityGuy/a25ea8bd475ab6c955ac42759e825287  
Then run your Torque game, call `dumpConsoleClasses(false);` and `dumpConsoleFunctions(false);` and paste their outputs to files called `consoleclasses.txt` and `consolefunctions.txt` respectively.  
Open your Torque project in VSCode and move the above files to its root directory, and create the following file:  
torquescript.config.json
```json
{
    "consoleClasses": "./consoleclasses.txt",
    "consoleFunctions": "./consolefunctions.txt"
}
```
This file lets the extension resolve engine defined classes, functions and methods. It will take a bit while for the extension 
to index and scan the project before its functionality works.

Also, if you are using an older version of engine that still uses `.cs` extension for TorqueScript, you can force VSCode to treat them as TorqueScript files by adding the following  to .vscode/settings.json:
```json
    "files.associations": {
        "*.cs": "torquescript"
    }
```

# Type Hints
TorqueScript doesn't have type safety and variables can hold anything. So `%obj.method()` can't normally be
resolved to a real method, hovered, or autocompleted. To get around that, the extension lets you
hint at what class a variable actually holds, and also guesses on its own in the obvious cases.
None of this is a real type system - if it can't figure something out it just does nothing, and it only complains when you've explicitly told it a type and the method doesn't exist on it.

## Annotations
Drop these in a `/** ... */` block comment right above the line in question (has to be `/** */`,
`//` won't be picked up):

**`@type ClassName`** above an assignment:
```
/** @type SimObject */
%obj = getSomeGenericThing();
```

**`@param %name ClassName`** above a function, one per parameter:
```
/**
 * @param %obj SimObject
 * @param %amount Float
 */
function damage(%obj, %amount)
{
    %obj.applyDamage(%amount); // now resolves
}
```

**`@returns ClassName`** above a function, so callers get the type too:
```
/** @returns SimObject */
function makeThing()
{
    return new SimObject();
}

%thing = makeThing();
%thing.getClassName(); // resolves through makeThing's @returns
```

`ClassName` doesn't have to be a real engine class, it also works for ScriptObject classes so it can resolve `MyNamespace::function();` if you specify the class as `MyNamespace`;

## Automatic type inference
The extension automatically infers types for trivial cases:
- `%obj = new SimObject();`: the type is obvious, no hint needed.
- `%obj = new SimObject(MyGlobalObj);` also remembers `MyGlobalObj` as a `SimObject`, so calling
  `MyGlobalObj.method();` somewhere else in the project works too.
- ScriptObjects that set `class = "MyNamespace";` or `superClass = ...;` pick up methods from matching
  namespace overrides as well as their real class.
- Reusing `%obj` later in the same function carries its type forward from the last assignment
  above it. This is just "nearest assignment above this line" and not real control-flow analysis, so it can get confused across branches/loops.

Chaining only goes one call deep off a variable (`%obj.a().b()` will have only `.a` resolved). To chain
further you need `@returns` on the function being called.

## Quick-add JSDoc
Cursor on a function or an assignment with no doc comment yet → open code actions (lightbulb /
`Ctrl+.`):
- **Add JSDoc for this function** - drops in a `@param`/`@returns` template.
- **Add @type annotation** - drops in `@type`, already filled in with the right class name if the
  extension can guess it.

## Diagnostics
Unresolved `.method()` calls stay quiet by default, it could just be a bad guess, or a gap in the
console dump. The only time you'll see a warning is when the type came from an explicit `@type` or
`@param` you wrote yourself and the method really isn't there.
