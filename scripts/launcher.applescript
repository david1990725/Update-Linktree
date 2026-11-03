on run
    set appPath to POSIX path of (path to me)
    try
        set parentPath to do shell script "/usr/bin/dirname " & quoted form of (text 1 thru -2 of appPath)
        set launcherPath to parentPath & "/scripts/launch-app.sh"
        do shell script "/bin/bash " & quoted form of launcherPath & " " & quoted form of appPath
    on error errorMessage
        display dialog errorMessage with title "每月活動同步" buttons {"好"} default button "好" with icon stop
    end try
end run
