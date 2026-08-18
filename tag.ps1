# Get next tag by incrementing patch from latest git tag
# e.g. 0.2.333 -> 0.2.334

$latestTag = git tag -l --sort=-v:refname 2>$null | Select-Object -First 1

if (-not $latestTag) {
    Write-Error "No git tags found"
    exit 1
}

# Strip optional 'v' prefix
$tag = $latestTag -replace '^v', ''

# Parse major.minor.patch
$parts = $tag -split '\.'
if ($parts.Count -lt 2) {
    Write-Error "Tag '$latestTag' does not match x.y.z format"
    exit 1
}

$patch = [int]$parts[-1]
$patch++
$parts[-1] = $patch

$newTag = $parts -join '.'
Write-Output $newTag

$tagName = "v$newTag"
git tag -a $tagName -m $tagName
git push origin $tagName
