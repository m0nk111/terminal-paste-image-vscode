import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('terminal-paste-image.pasteImage', async () => {
        try {
            await pasteImageFromClipboard();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to paste image: ${error}`);
        }
    });

    context.subscriptions.push(disposable);
}

async function pasteImageFromClipboard() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const config = vscode.workspace.getConfiguration('terminalPasteImage');
    const folderName = config.get<string>('folderName', '.cp-images');
    const autoGitIgnore = config.get<boolean>('autoGitIgnore', true);
    const maxImages = config.get<number>('maxImages', 10);

    const workspaceRootUri = workspaceFolders[0].uri;
    const imagesDirUri = vscode.Uri.joinPath(workspaceRootUri, folderName);

    // Create images directory if it doesn't exist
    try {
        await vscode.workspace.fs.stat(imagesDirUri);
    } catch {
        await vscode.workspace.fs.createDirectory(imagesDirUri);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
    const imageName = `pasted-image-${timestamp}.png`;
    const imageUri = vscode.Uri.joinPath(imagesDirUri, imageName);
    const relativePath = `${folderName}/${imageName}`;

    const hasImage = await checkClipboardForImage();
    if (!hasImage) {
        vscode.window.showWarningMessage('No image found in clipboard');
        return;
    }

    await saveClipboardImage(imageUri);

    // Handle .gitignore auto-update
    if (autoGitIgnore) {
        await updateGitIgnore(workspaceRootUri, folderName);
    }

    // Clean up old images
    await cleanupOldImages(imagesDirUri, maxImages);

    await insertPathInTerminal(relativePath);

    vscode.window.showInformationMessage(`Image saved and path inserted: ${relativePath}`);
}

async function isWSL(): Promise<boolean> {
    try {
        const { stdout } = await execAsync('uname -r');
        return stdout.toLowerCase().includes('microsoft');
    } catch {
        return false;
    }
}

async function getPowerShellPath(): Promise<string> {
    // Try common PowerShell locations in WSL
    const possiblePaths = [
        '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
        '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
        '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
        'powershell.exe' // Fallback to PATH
    ];

    for (const path of possiblePaths) {
        try {
            await execAsync(`test -f "${path}" || which "${path}"`);
            return path;
        } catch {
            continue;
        }
    }

    throw new Error('PowerShell.exe not found in WSL');
}

async function checkClipboardForImage(): Promise<boolean> {
    try {
        const platform = process.platform;
        const wsl = await isWSL();
        console.log(`Platform detected: ${platform}, WSL: ${wsl}`);

        let command: string;

        if (platform === 'linux' && wsl) {
            // In WSL, use PowerShell from Windows to check clipboard
            const psPath = await getPowerShellPath();
            command = `"${psPath}" -command "Get-Clipboard -Format Image"`;
        } else {
            switch (platform) {
                case 'win32':
                    command = 'powershell -command "Get-Clipboard -Format Image"';
                    break;
                case 'darwin':
                    command = 'osascript -e "clipboard info" | grep -q "«class PNGf»"';
                    break;
                case 'linux':
                    command = 'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -i image';
                    break;
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
        }

        console.log(`Executing command: ${command}`);

        const isInWSL = platform === 'linux' && wsl;

        try {
            const { stdout, stderr } = await execAsync(command);
            console.log(`Command stdout: ${stdout}`);
            console.log(`Command stderr: ${stderr}`);

            let hasImage = false;
            if (platform === 'win32' || isInWSL) {
                // PowerShell returns image properties when an image exists
                hasImage = stdout.trim().length > 0 && !stdout.includes('null');
            } else if (platform === 'linux') {
                hasImage = stdout.toLowerCase().includes('image');
            } else if (platform === 'darwin') {
                hasImage = true; // If grep succeeds, it found the image
            }

            console.log(`Has image result: ${hasImage}`);
            return hasImage;
        } catch (cmdError: any) {
            console.log(`Command error: ${cmdError.message}`);
            console.log(`Error code: ${cmdError.code}`);
            // For macOS, grep returns exit code 1 if pattern not found
            if (platform === 'darwin' && cmdError.code === 1) {
                console.log('No image found in clipboard (macOS grep pattern not found)');
                return false;
            }
            // For Linux, similar behavior
            if (platform === 'linux' && cmdError.code === 1) {
                console.log('No image found in clipboard (Linux grep pattern not found)');
                return false;
            }
            return false;
        }
    } catch (error) {
        console.error(`checkClipboardForImage error: ${error}`);
        return false;
    }
}

async function saveClipboardImage(targetUri: vscode.Uri): Promise<void> {
    const platform = process.platform;
    const wsl = await isWSL();

    // Save the image to a local temp file first, then copy it to the target URI
    // This is necessary because the extension runs on the local (UI) side where
    // clipboard access works, but the target path may be on a remote filesystem.
    const tempDir = os.tmpdir();
    const tempFileName = `cp-img-${Date.now()}.png`;
    const tempPath = path.join(tempDir, tempFileName);

    let command: string;

    if (platform === 'linux' && wsl) {
        // In WSL, we need to convert the WSL path to Windows path and use PowerShell
        const { stdout: winPath } = await execAsync(`wslpath -w "${tempPath}"`);
        const cleanWinPath = winPath.trim().replace(/\\/g, '\\\\');
        const psPath = await getPowerShellPath();
        command = `"${psPath}" -command "Add-Type -AssemblyName System.Windows.Forms; \\$img = [Windows.Forms.Clipboard]::GetImage(); if (\\$img -ne \\$null) { \\$img.Save('${cleanWinPath}'); }"`;
    } else {
        switch (platform) {
            case 'win32':
                command = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $img = [Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${tempPath}'); }"`;
                break;
            case 'darwin':
                command = `pngpaste "${tempPath}"`;
                break;
            case 'linux':
                command = `xclip -selection clipboard -t image/png -o > "${tempPath}"`;
                break;
            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }
    }

    console.log(`Saving image to temp path with command: ${command}`);
    await execAsync(command);

    // Read the temp file and write it to the target URI via VS Code's file system API
    // This works for both local and remote workspaces
    const tempUri = vscode.Uri.file(tempPath);
    const imageData = await vscode.workspace.fs.readFile(tempUri);
    await vscode.workspace.fs.writeFile(targetUri, imageData);

    // Clean up temp file
    try {
        await vscode.workspace.fs.delete(tempUri);
    } catch {
        // Ignore cleanup errors
    }
}

async function updateGitIgnore(workspaceRootUri: vscode.Uri, folderName: string): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(workspaceRootUri, '.gitignore');

    try {
        let gitignoreContent = '';
        try {
            const content = await vscode.workspace.fs.readFile(gitignoreUri);
            gitignoreContent = Buffer.from(content).toString('utf8');
        } catch {
            console.log('No .gitignore file found, skipping auto-update');
            return;
        }

        // Check if the folder is already in .gitignore
        const folderPattern = folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape special regex chars
        const patterns = [
            new RegExp(`^${folderPattern}/?$`, 'm'),    // Exact match
            new RegExp(`^${folderPattern}/\\*$`, 'm'),   // With wildcard
            new RegExp(`^\\*\\*/${folderPattern}/?$`, 'm'), // Recursive match
        ];

        const alreadyIgnored = patterns.some(pattern => pattern.test(gitignoreContent));

        if (!alreadyIgnored) {
            // Add the folder to .gitignore
            const newLine = gitignoreContent.endsWith('\n') ? '' : '\n';
            const updatedContent = `${gitignoreContent}${newLine}\n# Terminal Paste Image folder\n/${folderName}\n`;

            await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(updatedContent, 'utf8'));
            console.log(`Added ${folderName}/ to .gitignore`);
        } else {
            console.log(`${folderName} is already in .gitignore`);
        }
    } catch (error) {
        console.error('Error updating .gitignore:', error);
        // Don't show error to user as this is a convenience feature
    }
}

async function cleanupOldImages(imagesDirUri: vscode.Uri, maxImages: number): Promise<void> {
    try {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(imagesDirUri);
        } catch {
            return;
        }

        // Filter for image files (assuming they follow the pasted-image-*.png pattern)
        const imageFiles = entries.filter(([name, type]) =>
            type === vscode.FileType.File &&
            name.startsWith('pasted-image-') &&
            name.endsWith('.png')
        );

        if (imageFiles.length <= maxImages) {
            return; // No cleanup needed
        }

        // Get file stats and sort by modification time (newest first)
        const fileStats = await Promise.all(
            imageFiles.map(async ([name]) => {
                const fileUri = vscode.Uri.joinPath(imagesDirUri, name);
                const stat = await vscode.workspace.fs.stat(fileUri);
                return {
                    name,
                    uri: fileUri,
                    mtime: stat.mtime
                };
            })
        );

        fileStats.sort((a, b) => b.mtime - a.mtime);

        // Keep only the most recent maxImages files, delete the rest
        const filesToDelete = fileStats.slice(maxImages);

        for (const fileInfo of filesToDelete) {
            try {
                await vscode.workspace.fs.delete(fileInfo.uri);
                console.log(`Deleted old image: ${fileInfo.name}`);
            } catch (deleteError) {
                console.error(`Failed to delete ${fileInfo.name}:`, deleteError);
            }
        }

        if (filesToDelete.length > 0) {
            console.log(`Cleaned up ${filesToDelete.length} old images, kept ${maxImages} most recent`);
        }
    } catch (error) {
        console.error('Error during image cleanup:', error);
        // Don't show error to user as this is a maintenance feature
    }
}

async function insertPathInTerminal(imagePath: string): Promise<void> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
        vscode.window.showWarningMessage('No active terminal found');
        return;
    }

    activeTerminal.sendText(imagePath, false);
}

export function deactivate() {}
