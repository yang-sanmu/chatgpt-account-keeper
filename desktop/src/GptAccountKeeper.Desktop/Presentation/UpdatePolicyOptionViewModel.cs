using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

internal sealed record UpdatePolicyOptionViewModel(
    UpdatePolicy Value,
    string Title,
    string Description);
