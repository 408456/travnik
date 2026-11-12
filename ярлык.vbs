Set oWS = WScript.CreateObject("WScript.Shell")
sLinkFile = oWS.SpecialFolders("Desktop") & "\Travnik.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = "cmd.exe"
oLink.Arguments = "/c start """" start.cmd"
oLink.WorkingDirectory = oWS.CurrentDirectory
oLink.IconLocation = oWS.CurrentDirectory & "\icon.ico, 0"
oLink.Description = "Travnik Local Database"
oLink.WindowStyle = 7
oLink.Save
MsgBox "Shortcut created successfully!", 64, "Success"