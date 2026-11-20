@echo off
rem Test copy of the editor: its own settings and its own control files, so Claude sessions keep using the normal editor
rem and never join this window. Claude started in its terminal (Ctrl+`) works in this window only.
set SIMPLE_GLB_USERDATA=%APPDATA%\simple-glb-editor-dev
set SIMPLE_GLB_DEV=1
start "" "%~dp0dist-dev\win-unpacked\Simple GLB Editor.exe" %*
