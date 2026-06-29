# pi-jump-tree

Easily jump between sessions and tree leaves.

Each Pi session has a session ID, and each leaf/node in the session tree has an entry ID. This extension shows both in the footer so you can copy and then easily come back to it via e.g.: `/jump <session-id>:<leaf-entry-id>`.

## Demo

![pi-jump-tree demo](https://raw.githubusercontent.com/xRyul/pi-jump-tree/v0.1.1/demo.png)

Footer format:

```text
<session-id>:<leaf-entry-id>
```

Use that value directly with `/jump` to reopen the session and navigate to that leaf.

## Commands

- `/jump <entry-id-prefix>` - jump to an entry in the current session tree by entry ID.
- `/jump <session-id>:<entry-id-or-mark>` - switch to the matching session and jump to an entry ID or mark.
- `/jump-to-mark <mark>` - jump to a marked entry in the current session. Typing `/jump-to-mark ` shows all marks for selection/autocomplete.
- `/mark-leaf [mark]` - mark/bookmark the current leaf.
- `/unmark-leaf` - remove the mark/bookmark from the current leaf.
- `/unmark [entry-id-prefix|mark|mark:<mark>|#<mark>]` - remove a mark from a specific entry; with no argument, removes the current leaf mark.

## Examples

```text
/jump 019efa01-049b-7ee0-be17-6969205499de:a1b2c3d4
/jump 019efa01-049b-7ee0-be17-6969205499de:release-checkpoint
/jump a1b2c3d4
/jump-to-mark release-checkpoint
```

## Cross-session jumps

Qualified jump targets are portable across projects. For example:

```text
/jump 019efa01-049b-7ee0-be17-6969205499de:ec619574
```

The part before `:` is matched against known Pi session IDs, including sessions outside the current working directory. If a matching session file is found, the extension switches to that session, then resolves the part after `:` as an entry ID or mark inside that session.

Session lookup searches Pi's default session store and the current session manager's session directory. If multiple sessions match a prefix, Pi asks you to choose. Autocomplete is current-session only, so cross-session targets may need to be pasted or typed manually.

During cross-session lookup, the footer temporarily shows progress, for example:

```text
jump scanning all sessions [42/180 · 23%]
```

It then restores the usual `<session-id>:<leaf-entry-id>` footer once lookup finishes or the jump completes.

## Notes

Marks are stored as Pi session labels in the session JSONL file. They are session-scoped, not global.
If a mark conflicts with an entry ID prefix, use `/jump <session-id>:mark:<mark>` to force mark lookup.

Pi's built-in `/session` command is handled before extension commands, so this extension exposes the current session/leaf target through the footer/status area instead.

## Install locally

Symlink this directory into `~/.pi/agent/extensions/pi-jump-tree`, then run `/reload` in pi.
