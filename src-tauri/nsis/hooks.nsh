; Uninstall hooks for Setlist.
;
; Tauri's uninstaller clears the two app-data directories when "delete app data" is ticked,
; but it knows nothing about the Windows Credential Manager -- which is where the Spotify
; refresh tokens actually live, deliberately, so they never touch disk as plaintext. Without
; this hook an uninstall leaves two orphaned credentials behind permanently, and the user has
; no obvious way to find or remove them.
;
; Both target names are fixed. keyring composes a Windows target as "<user>.<service>" from
; the constants in src/spotify/auth.rs: KEYRING_SERVICE ("setlist"), KEYRING_USER and
; KEYRING_USER_STREAMING. Change those and these must change with them.
;
; Tied to the existing checkbox rather than a second one of its own: adding another control to
; the uninstall page needs a forked copy of Tauri's whole installer template, which would then
; need re-diffing on every Tauri upgrade. The saved login is app data, the relabelled checkbox
; now says so, and one switch covering all local state is easier to reason about than two.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
    DetailPrint "Removing the saved Spotify login from Windows Credential Manager..."
    ; nsExec runs these without flashing a console window. Exit codes are popped and ignored:
    ; a missing credential means the user never signed in, which is not a failure worth
    ; interrupting an uninstall over.
    nsExec::Exec 'cmdkey /delete:spotify-refresh-token.setlist'
    Pop $0
    nsExec::Exec 'cmdkey /delete:spotify-streaming-refresh-token.setlist'
    Pop $0
  ${EndIf}
!macroend
